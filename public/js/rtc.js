// =============================================================================
//  rtc.js: peer-to-peer connections with plain browser WebRTC
// =============================================================================
//
//  The big picture
//  ---------------
//  An RTCPeerConnection is a direct, encrypted link between two browsers.
//  Setting one up takes a short conversation through a middleman (our
//  Socket.IO server, the "signaling channel"):
//
//      Initiator (smaller device ID)            Responder
//      ------------------------------           ------------------------------
//      new RTCPeerConnection()
//      createDataChannel('control')   <- this is what we want to negotiate
//      createOffer() -> setLocalDescription()
//                    ---- offer (SDP) ---->     new RTCPeerConnection()
//                                               setRemoteDescription(offer)
//                                               createAnswer() -> setLocalDescription()
//                    <--- answer (SDP) ----
//      setRemoteDescription(answer)
//
//                    <--- ICE candidates ---->  (both directions, as each
//                                                side discovers addresses)
//
//      ...ICE tries candidate pairs, picks one that works...
//      connectionState: 'connected', and the data channel fires 'open'.
//
//  SDP ("Session Description Protocol") is a text blob describing what we
//  want (here: one SCTP association for data channels) plus security
//  fingerprints. ICE candidates are addresses to try: a "host" candidate is
//  a LAN address, "srflx" is your public address as seen by a STUN server,
//  "relay" is a TURN server. Same-Wi-Fi devices usually connect via "host".
//
//  Who sends the offer?
//  --------------------
//  If both sides sent offers at the same time ("glare") the negotiation
//  would collide. We avoid that with a fixed rule: the device whose ID sorts
//  first is always the initiator. The other side can ask it to start by
//  sending a small 'connect-request' signal.
//
//  Generations (pcId)
//  ------------------
//  Each new connection attempt gets a random pcId, sent with every signal.
//  Late messages from an old, abandoned attempt carry the wrong pcId and are
//  dropped instead of confusing the new connection.
// =============================================================================

const CONNECT_TIMEOUT_MS = 15_000;

/** Short random id. Not security-sensitive, just labels a connection attempt. */
const randomId = () => Math.random().toString(36).slice(2, 10);

/**
 * @param socket       the Socket.IO connection (used as the signaling channel)
 * @param iceServers   from GET /api/rtc-config (STUN, optionally TURN)
 * @param relayOnly    force traffic through TURN (for testing a TURN server)
 * @param getMyId      () => our device id
 * @param onState      (peerId, { state, route }) -> void, for the UI
 * @param onMessage    (peerId, message) -> void, JSON from the control channel
 * @param onChannel    (peerId, RTCDataChannel) -> void, extra channels the
 *                     other side opens (used for file transfers in Phase 4)
 * @param log          (text) -> void, for the "under the net" debug log
 */
export function createPeerManager({ socket, iceServers, relayOnly = false, getMyId, onState, onMessage, onChannel, log = () => {} }) {
  /** peerId -> Peer. See newPeer() for the shape. */
  const peers = new Map();
  /** peerId -> waiters, for a responder that asked for a connection and is
   *  waiting for the initiator's offer to arrive. */
  const awaitingOffer = new Map();

  const isInitiator = (peerId) => getMyId() < peerId;

  function signal(to, data) {
    socket.emit('rtc:signal', { to, data });
  }

  // ---------------------------------------------------------------------------
  //  Creating and tearing down a connection
  // ---------------------------------------------------------------------------

  /**
   * Start a fresh RTCPeerConnection for `peerId`, replacing any old one.
   * Anyone waiting on the old attempt (connect() callers) carries over.
   */
  function newPeer(peerId, pcId) {
    const carried = [...takeWaiters(peerId), ...(awaitingOffer.get(peerId) ?? [])];
    awaitingOffer.delete(peerId);
    closePeer(peerId, 'restart');

    // iceServers tells ICE which STUN/TURN servers to ask for candidates.
    // iceTransportPolicy 'relay' throws away every candidate except TURN
    // ones: the only way to be sure your TURN server really works.
    const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: relayOnly ? 'relay' : 'all' });
    const peer = {
      id: peerId,
      pcId,
      pc,
      control: null, // the 'control' RTCDataChannel once we have it
      pendingCandidates: [], // candidates that arrived before the remote SDP
      state: 'connecting',
      route: null, // 'host' | 'srflx' | 'prflx' | 'relay' once connected
      startedAt: Date.now(),
      waiters: carried, // { resolve, reject } for connect() calls in progress
    };
    peers.set(peerId, peer);
    setState(peer, 'connecting');

    // Watchdog: if ICE finds no usable path it can sit in 'checking' for a
    // long time (or forever, with no candidates at all) without reporting
    // 'failed'. Give up after a while so the UI can say so.
    setTimeout(() => {
      if (peers.get(peerId) === peer && peer.state === 'connecting') {
        log(`${short(peerId)} gave up: no working path found`);
        closePeer(peerId, 'failed');
      }
    }, CONNECT_TIMEOUT_MS);

    // ICE found a way the other side might reach us: pass it on. A `null`
    // candidate just means "done gathering", so there's nothing to send.
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      log(`→ ${short(peerId)} ICE candidate (${candidate.type || 'unknown'})`);
      signal(peerId, { type: 'candidate', pcId, candidate: candidate.toJSON() });
    };

    // The overall health of the link. 'disconnected' can recover by itself
    // (e.g. Wi-Fi blip); 'failed' means ICE gave up.
    pc.onconnectionstatechange = () => {
      if (peers.get(peerId) !== peer) return; // an old, replaced connection
      log(`${short(peerId)} connection: ${pc.connectionState}`);
      if (pc.connectionState === 'connected') detectRoute(peer);
      if (pc.connectionState === 'failed') {
        closePeer(peerId, 'failed');
      } else if (pc.connectionState === 'disconnected') {
        setState(peer, 'reconnecting');
      }
    };

    // Channels opened by the *other* side arrive here.
    pc.ondatachannel = ({ channel }) => {
      if (channel.label === 'control') setupControl(peer, channel);
      else onChannel?.(peerId, channel);
    };

    return peer;
  }

  /** Wire up the JSON 'control' channel (pings now, file offers in Phase 4). */
  function setupControl(peer, channel) {
    peer.control = channel;
    channel.onopen = () => {
      log(`${short(peer.id)} control channel open ✓`);
      setState(peer, 'connected');
      peer.waiters.splice(0).forEach((w) => w.resolve(peer));
    };
    channel.onclose = () => {
      if (peers.get(peer.id) === peer) closePeer(peer.id, 'closed');
    };
    channel.onmessage = ({ data }) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return; // not ours: ignore
      }
      onMessage?.(peer.id, msg);
    };
  }

  function closePeer(peerId, reason = 'closed') {
    const peer = peers.get(peerId);
    if (!peer) return;
    peers.delete(peerId);
    peer.pc.close(); // also closes every data channel on it
    peer.waiters.splice(0).forEach((w) => w.reject(new Error(reason)));
    if (reason === 'restart') return; // a new attempt takes over right away
    log(`${short(peerId)} closed (${reason})`);
    onState?.(peerId, { state: reason === 'failed' ? 'failed' : 'idle', route: null });
  }

  function takeWaiters(peerId) {
    const peer = peers.get(peerId);
    return peer ? peer.waiters.splice(0) : [];
  }

  function setState(peer, state) {
    peer.state = state;
    onState?.(peer.id, { state, route: peer.route });
  }

  /**
   * Which kind of path did ICE pick? We read it from getStats():
   * the selected candidate pair -> our local candidate -> its type.
   */
  async function detectRoute(peer) {
    try {
      const stats = await peer.pc.getStats();
      let pair = null;
      stats.forEach((r) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
      });
      if (!pair) {
        // Firefox doesn't expose selectedCandidatePairId. Look for the pair
        // that is nominated and working instead.
        stats.forEach((r) => {
          if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
        });
      }
      const local = pair && stats.get(pair.localCandidateId);
      peer.route = local?.candidateType ?? null;
      log(`${short(peer.id)} route: ${peer.route ?? 'unknown'}`);
      if (peers.get(peer.id) === peer) setState(peer, peer.state);
    } catch {
      // Stats are a nice-to-have.
    }
  }

  // ---------------------------------------------------------------------------
  //  Initiator side
  // ---------------------------------------------------------------------------

  /** Returns the new Peer right away; the offer goes out asynchronously. */
  function startConnection(peerId) {
    const peer = newPeer(peerId, randomId());
    const { pc, pcId } = peer;

    // Creating a data channel *before* the offer is what puts a data section
    // in the SDP. Without at least one channel (or media track) there would
    // be nothing to negotiate. The responder receives it via ondatachannel.
    setupControl(peer, pc.createDataChannel('control', { ordered: true }));

    (async () => {
      try {
        // setLocalDescription() with no argument creates the offer for us
        // (the modern shorthand for createOffer() + setLocalDescription(offer)).
        await pc.setLocalDescription();
        log(`→ ${short(peerId)} offer`);
        signal(peerId, { type: 'offer', pcId, sdp: pc.localDescription.toJSON() });
      } catch (err) {
        log(`offer failed: ${err.message}`);
        if (peers.get(peerId) === peer) closePeer(peerId, 'failed');
      }
    })();
    return peer;
  }

  // ---------------------------------------------------------------------------
  //  Handling signals from the other device
  // ---------------------------------------------------------------------------

  socket.on('rtc:signal', async ({ from, data }) => {
    try {
      switch (data.type) {
        case 'connect-request': {
          // The responder wants a connection. Restart unless one is already
          // underway (we may have started one ourselves a moment ago).
          if (!isInitiator(from)) return;
          const existing = peers.get(from);
          const busy = existing && existing.state === 'connecting' && Date.now() - existing.startedAt < 5000;
          log(`← ${short(from)} connect-request`);
          if (!busy) startConnection(from);
          return;
        }

        case 'offer': {
          // Only the initiator may send offers, and every offer means a fresh
          // connection, so drop any old one with this peer.
          if (isInitiator(from)) return;
          log(`← ${short(from)} offer`);
          const peer = newPeer(from, data.pcId);
          await peer.pc.setRemoteDescription(data.sdp);
          await flushCandidates(peer);
          // With a remote offer in place, this creates and applies an answer.
          await peer.pc.setLocalDescription();
          log(`→ ${short(from)} answer`);
          signal(from, { type: 'answer', pcId: data.pcId, sdp: peer.pc.localDescription.toJSON() });
          return;
        }

        case 'answer': {
          const peer = peers.get(from);
          if (!peer || peer.pcId !== data.pcId) return; // stale
          log(`← ${short(from)} answer`);
          await peer.pc.setRemoteDescription(data.sdp);
          await flushCandidates(peer);
          return;
        }

        case 'candidate': {
          const peer = peers.get(from);
          if (!peer || peer.pcId !== data.pcId) return; // stale
          // addIceCandidate() throws if the remote description isn't set yet.
          // Candidates can overtake the offer/answer while we're still
          // processing it, so park them until it's ready.
          if (!peer.pc.remoteDescription) peer.pendingCandidates.push(data.candidate);
          else await peer.pc.addIceCandidate(data.candidate);
          return;
        }
      }
    } catch (err) {
      log(`signal error (${data?.type}): ${err.message}`);
    }
  });

  async function flushCandidates(peer) {
    for (const c of peer.pendingCandidates.splice(0)) {
      await peer.pc.addIceCandidate(c).catch((err) => log(`bad candidate: ${err.message}`));
    }
  }

  // ---------------------------------------------------------------------------
  //  Public API
  // ---------------------------------------------------------------------------

  /**
   * Resolve with an open connection to `peerId`, creating one if needed.
   * Rejects if it doesn't open within CONNECT_TIMEOUT_MS.
   */
  function connect(peerId) {
    const existing = peers.get(peerId);
    if (existing?.control?.readyState === 'open') return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = peers.get(peerId);
        if (p) p.waiters = p.waiters.filter((w) => w.resolve !== done);
        const list = awaitingOffer.get(peerId);
        if (list) awaitingOffer.set(peerId, list.filter((w) => w.resolve !== done));
        reject(new Error('timeout'));
      }, CONNECT_TIMEOUT_MS);
      const done = (peer) => {
        clearTimeout(timer);
        resolve(peer);
      };
      const fail = (err) => {
        clearTimeout(timer);
        reject(err);
      };

      const waiter = { resolve: done, reject: fail };
      const peer = peers.get(peerId);
      if (peer) {
        peer.waiters.push(waiter); // an attempt is already underway
      } else if (isInitiator(peerId)) {
        startConnection(peerId).waiters.push(waiter);
      } else {
        // We're the responder: ask the initiator to start, and wait for its
        // offer (the offer handler hands these waiters to the new Peer).
        const list = awaitingOffer.get(peerId) ?? [];
        if (list.length === 0) {
          log(`→ ${short(peerId)} connect-request`);
          signal(peerId, { type: 'connect-request' });
        }
        list.push(waiter);
        awaitingOffer.set(peerId, list);
      }
    });
  }

  /** Send a JSON message over the control channel (connecting first if needed). */
  async function send(peerId, message) {
    const peer = await connect(peerId);
    peer.control.send(JSON.stringify(message));
    return peer;
  }

  /**
   * Keep connections in line with the court's device list:
   * close links to devices that left (or reloaded: new session), and as the
   * initiator, open links to newcomers so they're ready before you need them.
   */
  const sessions = new Map(); // peerId -> session we last saw
  function syncDevices(devices, { eager }) {
    const me = getMyId();
    const present = new Map(devices.filter((d) => d.id !== me).map((d) => [d.id, d.session]));
    for (const [peerId] of peers) {
      // A new session id means the device reloaded: its old connection is
      // dead. (No known session yet = its offer beat the device list here.)
      const known = sessions.get(peerId);
      if (!present.has(peerId) || (known && known !== present.get(peerId))) closePeer(peerId, 'left');
    }
    sessions.clear();
    for (const [peerId, session] of present) {
      sessions.set(peerId, session);
      if (eager && isInitiator(peerId) && !peers.has(peerId)) startConnection(peerId);
    }
  }

  function closeAll() {
    for (const peerId of [...peers.keys()]) closePeer(peerId, 'left');
  }

  return { connect, send, syncDevices, closeAll, get: (id) => peers.get(id) };
}

function short(id) {
  return id.slice(0, 4);
}
