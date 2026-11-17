(function () {
  var roomId = (window.location.pathname.split('/r/')[1] || '').split(/[?#]/)[0];
  var lobby = document.getElementById('screen-lobby');
  var call = document.getElementById('screen-call');
  var heading = document.getElementById('room-heading');
  var sub = document.getElementById('lobby-sub');
  var nameInput = document.getElementById('join-name');
  var passcodeRow = document.getElementById('passcode-row');
  var passcodeInput = document.getElementById('join-passcode');
  var joinBtn = document.getElementById('join-btn');
  var roomLocked = false;
  var preview = document.getElementById('preview');
  var localVideo = document.getElementById('local-video');
  var remoteVideo = document.getElementById('remote-video');
  var waiting = document.getElementById('waiting');
  var ended = document.getElementById('ended');
  var rejoinBtn = document.getElementById('rejoin-btn');
  var endedShown = false;
  var statusBar = document.getElementById('status-bar');
  var toast = document.getElementById('toast');
  var connBadge = document.getElementById('conn-badge');
  var peerMuted = document.getElementById('peer-muted');
  var remoteAudioCtx = null;
  var remoteAnalyser = null;
  var remoteMuteState = false;
  var remoteSilent = false;
  var peerMedia = {};

  var ICE = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  var peerId = null;
  var myJoinedAt = 0;
  var localStream = null;
  var screenStream = null;
  var facing = 'user';
  var pollTimer = null;
  var peersSeen = {};
  var eventSource = null;
  var lastSignalSeq = 0;
  var conns = {};
  var remoteOrder = [];
  var micOn = true;
  var camOn = true;

  var micBtn = document.getElementById('mic-btn');
  var camBtn = document.getElementById('cam-btn');
  var flipBtn = document.getElementById('flip-btn');
  var shareBtn = document.getElementById('share-btn');
  var copyBtn = document.getElementById('copy-btn');
  var copyWaitBtn = document.getElementById('copy-wait-btn');
  var leaveBtn = document.getElementById('leave-btn');

  // Warn before an accidental tab close or reload drops an active call.
  // Only prompts while a peer is connected; the browser shows its own generic text.
  window.addEventListener('beforeunload', function (e) {
    if (remoteOrder && remoteOrder.length > 0) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  });

  try {
    var saved = window.localStorage.getItem('linkup:name');
    if (saved) nameInput.value = saved;
  } catch (e) { /* ignore */ }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () { toast.classList.add('hidden'); }, 2800);
  }

  function setStatus(text) {
    statusBar.textContent = text;
    var live = document.getElementById('status-live');
    if (live && live.textContent !== text) live.textContent = text;
  }

  var callStartedAt = 0;
  var callTimerId = null;
  function startCallTimer() {
    if (callTimerId) return;
    callStartedAt = Date.now();
    callTimerId = setInterval(function () {
      // Only time a connected period: when the call leaves 'In call', stop and
      // re-anchor on the next connection so a reconnect starts from 00:00.
      if (statusBar.textContent.indexOf('In call') !== 0) {
        clearInterval(callTimerId);
        callTimerId = null;
        callStartedAt = 0;
        return;
      }
      var secs = Math.floor((Date.now() - callStartedAt) / 1000);
      var mm = String(Math.floor(secs / 60)).padStart(2, '0');
      var ss = String(secs % 60).padStart(2, '0');
      statusBar.textContent = statusBar.textContent.replace(/ · \d\d:\d\d$/, '') + ' · ' + mm + ':' + ss;
    }, 1000);
  }

  function setConnState(state) {
    if (!connBadge) return;
    connBadge.classList.remove('ok', 'bad', 'idle');
    if (state === 'idle') {
      connBadge.textContent = 'Waiting';
      connBadge.classList.add('idle');
    } else if (state === 'connected') {
      connBadge.textContent = 'Connected';
      connBadge.classList.add('ok');
    } else if (state === 'failed' || state === 'disconnected') {
      connBadge.textContent = state === 'failed' ? 'Connection failed' : 'Reconnecting…';
      connBadge.classList.add('bad');
    } else {
      connBadge.textContent = 'Connecting…';
    }
  }

  function showConnFailure(id) {
    var panel = document.getElementById('conn-failure');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'conn-failure';
      panel.setAttribute('role', 'alert');
      panel.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:50;max-width:min(92vw,420px);padding:20px;border-radius:12px;background:#1f2937;color:#f9fafb;box-shadow:0 10px 30px rgba(0,0,0,.4);text-align:center;font-size:15px;line-height:1.4';
      var msg = document.createElement('p');
      msg.id = 'conn-failure-msg';
      msg.style.margin = '0 0 14px';
      var btn = document.createElement('button');
      btn.id = 'conn-retry-btn';
      btn.type = 'button';
      btn.textContent = 'Retry connection';
      btn.style.cssText = 'padding:10px 18px;border:0;border-radius:8px;background:#3b82f6;color:#fff;font-size:15px;cursor:pointer';
      btn.addEventListener('click', function () { retryPeer(panel.getAttribute('data-peer')); });
      panel.appendChild(msg);
      panel.appendChild(btn);
      call.appendChild(panel);
    }
    panel.setAttribute('data-peer', id);
    document.getElementById('conn-failure-msg').textContent = 'Could not connect directly to the other person. This often happens on restrictive networks or mobile data. Try again, or switch networks (for example Wi-Fi to mobile data).';
    panel.classList.remove('hidden');
    panel.style.display = 'block';
    setConnState('failed');
  }

  function hideConnFailure() {
    var panel = document.getElementById('conn-failure');
    if (panel) panel.style.display = 'none';
  }

  function retryPeer(id) {
    if (!id) return;
    hideConnFailure();
    var old = conns[id];
    if (old && old.pc) { try { old.pc.close(); } catch (e) { /* ignore */ } }
    delete conns[id];
    signal(id, { retry: true });
    connectTo(peersSeen[id] || { id: id, joinedAt: 0 });
    setConnState('connecting');
    showToast('Retrying the connection...');
  }

  function updatePeerBadge() {
    var id = remoteOrder[0];
    var state = id ? peerMedia[id] : null;
    var micOff = state ? !state.mic : remoteSilent;
    var camOff = state ? !state.cam : false;
    var text = '';
    if (micOff && camOff) text = '🔇 📷 Peer mic and camera are off';
    else if (micOff) text = '🔇 Peer muted';
    else if (camOff) text = '📷 Peer camera is off';
    peerMuted.textContent = text;
    peerMuted.classList.toggle('hidden', !text);
  }

  function broadcastMediaState() {
    var payload = { mediaState: { mic: micOn, cam: camOn } };
    Object.keys(conns).forEach(function (id) { signal(id, payload); });
  }

  function startMuteDetection(stream) {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC || !stream.getAudioTracks().length) return;
      if (!remoteAudioCtx) remoteAudioCtx = new AC();
      var src = remoteAudioCtx.createMediaStreamSource(stream);
      remoteAnalyser = remoteAudioCtx.createAnalyser();
      remoteAnalyser.fftSize = 256;
      src.connect(remoteAnalyser);
      var buf = new Uint8Array(remoteAnalyser.frequencyBinCount);
      var framesSilent = 0;
      var tick = function () {
        if (!remoteAnalyser) return;
        remoteAnalyser.getByteFrequencyData(buf);
        var level = 0;
        for (var i = 0; i < buf.length; i++) level = Math.max(level, buf[i]);
        if (level < 4) framesSilent++;
        else framesSilent = 0;
        // ~2 seconds of continuous silence (30fps tick ≈ 66ms) = muted
        var muted = framesSilent > 30;
        if (muted !== remoteSilent) {
          remoteSilent = muted;
          updatePeerBadge();
        }
        requestAnimationFrame(tick);
      };
      tick();
    } catch (e) { /* audio analysis optional */ }
  }

  if (!roomId) {
    heading.textContent = 'Invalid link';
    sub.textContent = 'This call link is missing a room id.';
    joinBtn.disabled = true;
    return;
  }

  fetch('/api/rooms/' + encodeURIComponent(roomId))
    .then(function (r) {
      if (r.status === 404) throw new Error('notfound');
      return r.json();
    })
    .then(function (data) {
      if (data.error) throw new Error(data.error);
      heading.textContent = data.title;
      sub.textContent = 'Hosted by ' + data.hostName + '. Enter your name to join.';
      if (data.locked) {
        roomLocked = true;
        passcodeRow.classList.remove('hidden');
        sub.textContent = 'Hosted by ' + data.hostName + '. This room is locked — ask the host for the passcode.';
      }
      document.title = data.title + ' - LinkUp';
    })
    .catch(function (err) {
      if (err && err.message === 'notfound') {
        heading.textContent = 'This call has ended';
        sub.textContent = 'This room was closed after it sat empty, or the link is wrong. Create a new room from the home page.';
      } else {
        heading.textContent = 'Could not open this room';
        sub.textContent = 'Check your connection and try the link again.';
      }
      joinBtn.disabled = true;
    });

  function mediaErrorMessage(err) {
    var name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Camera or microphone access is blocked. Allow access in your browser site settings, then rejoin. Continuing without them.';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return 'No camera or microphone was found. Continuing without them.';
    }
    if (name === 'NotReadableError' || name === 'AbortError') {
      return 'Your camera or microphone is in use by another app. Close it and rejoin. Continuing without them.';
    }
    return 'Could not start your camera or microphone. Continuing without them.';
  }

  // Names which devices are live so the person knows what the others will get.
  function mediaStatusPrefix(stream) {
    if (!stream) return 'Room is open. No camera or microphone -';
    var hasAudio = stream.getAudioTracks().length > 0;
    var hasVideo = stream.getVideoTracks().length > 0;
    if (hasAudio && hasVideo) return 'Room is open. Camera and microphone on -';
    if (hasAudio) {
      var label = stream.getAudioTracks()[0].label;
      return label
        ? 'Room is open. Microphone on (' + label + '), camera off -'
        : 'Room is open. Microphone on, camera off -';
    }
    if (hasVideo) return 'Room is open. Camera on, microphone off -';
    return 'Room is open. No camera or microphone -';
  }

  function getMedia(useFacing) {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: {
        facingMode: useFacing || facing,
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 }
      }
    });
  }

  function applySavedMediaPrefs() {
    // Only two booleans are stored locally; no media data or identifiers.
    var saved = null;
    try { saved = JSON.parse(window.localStorage.getItem('linkup:media') || 'null'); } catch (e) { saved = null; }
    if (!saved || typeof saved !== 'object') return;
    if (typeof saved.mic === 'boolean') micOn = saved.mic;
    if (typeof saved.cam === 'boolean') camOn = saved.cam;
    if (localStream) {
      localStream.getAudioTracks().forEach(function (t) { t.enabled = micOn; });
      localStream.getVideoTracks().forEach(function (t) { t.enabled = camOn; });
    }
  }

  function saveMediaPrefs() {
    try { window.localStorage.setItem('linkup:media', JSON.stringify({ mic: micOn, cam: camOn })); } catch (e) { /* ignore */ }
  }

  function startPreview() {
    if (localStream) return Promise.resolve(localStream);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('This browser cannot access the camera. Use a modern browser on an https page.'));
    }
    return getMedia().then(function (stream) {
      localStream = stream;
      applySavedMediaPrefs();
      preview.srcObject = stream;
      localVideo.srcObject = stream;
      watchMediaTracks();
      syncMediaControls();
      return stream;
    });
  }

  joinBtn.addEventListener('click', function () {
    var name = nameInput.value.trim() || 'Guest';
    try { window.localStorage.setItem('linkup:name', name); } catch (e) { /* ignore */ }
    joinBtn.disabled = true;
    joinBtn.textContent = 'Starting...';

    var mediaPromise = localStream
      ? Promise.resolve(localStream)
      : startPreview().catch(function (err) {
          showToast(mediaErrorMessage(err));
          return null;
        });

    mediaPromise
      .then(function (stream) {
        return fetch('/api/rooms/' + encodeURIComponent(roomId) + '/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name, passcode: roomLocked ? (passcodeInput.value.trim() || undefined) : undefined })
        })
          .then(function (r) {
            if (r.status === 403) {
              passcodeRow.classList.remove('hidden');
              passcodeInput.classList.add('bad');
              throw new Error('Wrong passcode — ask the host for the correct one.');
            }
            return r.json();
          })
          .then(function (data) {
            if (!data.peerId) throw new Error(data.error || 'Could not join');
            peerId = data.peerId;
            myJoinedAt = (data.peers || []).reduce(function (acc, p) {
              return p.id === peerId ? p.joinedAt : acc;
            }, Date.now());
            enterCall();
            (data.peers || []).forEach(function (p) {
              peersSeen[p.id] = p;
              if (p.id !== peerId) connectTo(p);
            });
            startPolling();
            setStatus(mediaStatusPrefix(stream) + ' Only you are here — waiting for the other person to join with this link.');
          });
      })
      .catch(function (err) {
        showToast(err.message || 'Could not join the call');
        joinBtn.disabled = false;
        joinBtn.textContent = 'Join call';
      });

  passcodeInput.addEventListener('input', function () {
    passcodeInput.classList.remove('bad');
  });
  });

  function enterCall() {
    lobby.classList.add('hidden');
    call.classList.remove('hidden');
    if (localStream) localVideo.srcObject = localStream;
    syncMediaControls();
    fillInviteLink();
    waiting.classList.remove('hidden');
    setConnState('idle');
  }

  function updateWaiting() {
    waiting.classList.toggle('hidden', remoteOrder.length > 0 || endedShown);
    ended.classList.toggle('hidden', !endedShown);
  }

  function showEnded() {
    endedShown = true;
    updateWaiting();
  }

  function hideEnded() {
    endedShown = false;
    updateWaiting();
  }

  rejoinBtn.addEventListener('click', function () {
    window.location.reload();
  });

  function post(path, body, beacon) {
    var url = '/api/rooms/' + encodeURIComponent(roomId) + path;
    if (beacon && navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([JSON.stringify(body)], { type: 'application/json' }));
      return Promise.resolve();
    }
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).catch(function () { /* transient */ });
  }

  function signal(to, payload) {
    if (!peerId) return;
    post('/signal', { from: peerId, to: to, payload: payload });
  }

  function startPolling() {
    startStream();
    if (pollTimer) return;
    pollTimer = setInterval(poll, 700);
    poll();
  }

  // Server-sent events keep presence and signals live; the poll stays as a fallback.
  function acceptSignal(m) {
    if (!m) return false;
    if (typeof m.seq === 'number') {
      if (m.seq <= lastSignalSeq) return false;
      lastSignalSeq = m.seq;
    }
    return true;
  }

  function startStream() {
    if (eventSource || !window.EventSource || !peerId) return;
    try {
      eventSource = new EventSource('/api/rooms/' + encodeURIComponent(roomId) + '/stream?peerId=' + encodeURIComponent(peerId));
    } catch (e) { eventSource = null; return; }
    eventSource.addEventListener('peers', function (ev) {
      try { reconcile(JSON.parse(ev.data).peers || []); } catch (e) { /* ignore */ }
    });
    eventSource.addEventListener('signal', function (ev) {
      try {
        var m = JSON.parse(ev.data);
        if (acceptSignal(m)) handleSignal(m.from, m.payload);
      } catch (e) { /* ignore */ }
    });
    eventSource.addEventListener('gone', function () {
      stopStream();
      setStatus('Disconnected from the room');
    });
  }

  function stopStream() {
    if (eventSource) { try { eventSource.close(); } catch (e) { /* ignore */ } }
    eventSource = null;
  }

  function poll() {
    if (!peerId) return;
    fetch('/api/rooms/' + encodeURIComponent(roomId) + '/poll?peerId=' + encodeURIComponent(peerId))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.gone) {
          setStatus('Disconnected from the room');
          return;
        }
        (data.messages || []).forEach(function (m) {
          if (acceptSignal(m)) handleSignal(m.from, m.payload);
        });
        reconcile(data.peers || []);
      })
      .catch(function () { setStatus('Reconnecting...'); });
  }

  function reconcile(list) {
    var present = {};
    list.forEach(function (p) {
      present[p.id] = true;
      if (p.id === peerId) return;
      if (!peersSeen[p.id]) {
        peersSeen[p.id] = p;
        connectTo(p);
      }
    });
    Object.keys(conns).forEach(function (id) {
      if (!present[id]) dropPeer(id);
    });
    Object.keys(peersSeen).forEach(function (id) {
      if (!present[id] && id !== peerId) delete peersSeen[id];
    });
    updateWaiting();
  }

  function dropPeer(id) {
    var c = conns[id];
    if (c && c.pc) { try { c.pc.close(); } catch (e) { /* ignore */ } }
    clearTimeout(c && c.stuckTimer);
    hideConnFailure();
    delete conns[id];
    var wasOnScreen = remoteOrder.indexOf(id) !== -1;
    remoteOrder = remoteOrder.filter(function (x) { return x !== id; });
    if (remoteOrder.length === 0) {
      remoteVideo.srcObject = null;
      remoteAnalyser = null;
      remoteSilent = false;
    }
    delete peerMedia[id];
    updatePeerBadge();
    if (remoteOrder.length) attachRemote(remoteOrder[0]);
    if (wasOnScreen && remoteOrder.length === 0) showEnded();
    setStatus(remoteOrder.length ? 'In call with ' + remoteOrder.length + ' person(s)' : (endedShown ? 'The other person left the call' : 'Only you are in this room — waiting for the other person to join with this link.'));
    setConnState(remoteOrder.length ? 'connected' : 'idle');
  }

  function attachRemote(id) {
    var c = conns[id];
    if (!c || !c.stream) return;
    if (remoteVideo.srcObject !== c.stream) {
      remoteVideo.srcObject = c.stream;
      startMuteDetection(c.stream);
      var p = remoteVideo.play();
      if (p && p.catch) p.catch(function () { /* autoplay may need a gesture */ });
    }
    updateWaiting();
  }
  function connectTo(peer) {
    if (conns[peer.id]) return;
    // Deterministic: the peer with the smaller id creates the offer, so two
    // clients can never both send one (no glare).
    var isOfferer = String(peerId) < String(peer.id);
    var pc = new RTCPeerConnection(ICE);
    var entry = { pc: pc, stream: new MediaStream(), isOfferer: isOfferer };
    conns[peer.id] = entry;
    entry.stuckTimer = setTimeout(function () {
      if (conns[peer.id] === entry && pc.connectionState !== 'connected') showConnFailure(peer.id);
    }, 15000);

    if (localStream) {
      localStream.getTracks().forEach(function (t) { pc.addTrack(t, localStream); });
    } else {
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.addTransceiver('video', { direction: 'recvonly' });
    }
    signal(peer.id, { mediaState: { mic: micOn, cam: camOn } });

    pc.onicecandidate = function (ev) {
      if (ev.candidate) signal(peer.id, { candidate: ev.candidate });
    };

    pc.ontrack = function (ev) {
      var stream = ev.streams && ev.streams[0] ? ev.streams[0] : entry.stream;
      entry.stream = stream;
      if (remoteOrder.indexOf(peer.id) === -1) remoteOrder.push(peer.id);
      hideEnded();
      if (remoteOrder[0] === peer.id) attachRemote(peer.id);
      setStatus('In call with ' + remoteOrder.length + ' person(s)');
      updateWaiting();
    };

    pc.onconnectionstatechange = function () {
      setConnState(pc.connectionState);
      if (pc.connectionState === 'connected') {
        clearTimeout(entry.stuckTimer);
        hideConnFailure();
        setStatus('In call with ' + Math.max(1, remoteOrder.length) + ' person(s)');
        startCallTimer();
      } else if (pc.connectionState === 'failed') {
        showConnFailure(peer.id);
        try { pc.restartIce(); } catch (e) { /* ignore */ }
      }
    };

    if (isOfferer) {
      pc.createOffer()
        .then(function (offer) { return pc.setLocalDescription(offer); })
        .then(function () { signal(peer.id, { sdp: pc.localDescription }); })
        .catch(function () { /* ignore */ });
    }
  }

  function handleSignal(from, payload) {
    if (!payload) return;
    if (payload.mediaState) {
      peerMedia[from] = { mic: !!payload.mediaState.mic, cam: !!payload.mediaState.cam };
      updatePeerBadge();
      return;
    }
    if (payload.retry) {
      var stale = conns[from];
      if (stale && stale.pc) { try { stale.pc.close(); } catch (e) { /* ignore */ } }
      delete conns[from];
      connectTo(peersSeen[from] || { id: from, joinedAt: 0 });
      return;
    }
    var entry = conns[from];
    if (!entry && (payload.sdp || payload.candidate)) {
      var p = peersSeen[from] || { id: from, joinedAt: 0 };
      peersSeen[from] = p;
      connectTo(p);
      entry = conns[from];
    }
    if (!entry) return;
    var pc = entry.pc;

    if (payload.sdp) {
      var desc = payload.sdp;
      pc.setRemoteDescription(new RTCSessionDescription(desc))
        .then(function () {
          if (desc.type !== 'offer') return null;
          return pc.createAnswer()
            .then(function (ans) { return pc.setLocalDescription(ans); })
            .then(function () { signal(from, { sdp: pc.localDescription }); });
        })
        .catch(function () { /* ignore glare */ });
    } else if (payload.candidate) {
      pc.addIceCandidate(new RTCIceCandidate(payload.candidate)).catch(function () {});
    }
  }

  function liveTracks(kind) {
    return localStream ? localStream.getTracks().filter(function (t) {
      return t.kind === kind && t.readyState === 'live';
    }) : [];
  }

  // A pressed toggle means enabled, not muted. Keep its accessible name stable.
  function syncMediaControls() {
    var audio = liveTracks('audio');
    var video = liveTracks('video');
    micOn = audio.some(function (t) { return t.enabled; });
    camOn = video.some(function (t) { return t.enabled; });
    [[micBtn, 'mic-state', audio.length, micOn, 'Microphone', 'muted', 'M'],
      [camBtn, 'cam-state', video.length, camOn, 'Camera', 'off', 'V']].forEach(function (c) {
      var state = c[4] + (c[2] ? (c[3] ? ' on' : ' ' + c[5]) : ' unavailable');
      c[0].setAttribute('aria-pressed', String(c[3]));
      c[0].setAttribute('aria-disabled', String(!c[2]));
      c[0].classList.toggle('off', !c[3]);
      c[0].title = state + ' (' + c[6] + ')';
      document.getElementById(c[1]).textContent = state;
    });
  }

  function watchMediaTracks() {
    if (!localStream) return;
    localStream.getTracks().forEach(function (t) {
      t.addEventListener('ended', function () {
        syncMediaControls();
        broadcastMediaState();
      });
    });
  }

  micBtn.addEventListener('click', function () {
    if (!liveTracks('audio').length) { syncMediaControls(); showToast('No microphone available'); return; }
    micOn = !micOn;
    localStream.getAudioTracks().forEach(function (t) { t.enabled = micOn; });
    saveMediaPrefs();
    syncMediaControls();
    broadcastMediaState();
    showToast(micOn ? 'Microphone on' : 'Microphone muted');
  });

  camBtn.addEventListener('click', function () {
    if (!liveTracks('video').length) { syncMediaControls(); showToast('No camera available'); return; }
    camOn = !camOn;
    localStream.getVideoTracks().forEach(function (t) { t.enabled = camOn; });
    saveMediaPrefs();
    syncMediaControls();
    broadcastMediaState();
    showToast(camOn ? 'Camera on' : 'Camera off');
  });

  flipBtn.addEventListener('click', function () {
    if (!localStream) { showToast('No camera available'); return; }
    facing = facing === 'user' ? 'environment' : 'user';
    getMedia(facing).then(function (stream) {
      var newTrack = stream.getVideoTracks()[0];
      // Preserve the current camera setting before exposing or sending the new track.
      // The user may have toggled the camera while getUserMedia was pending.
      newTrack.enabled = camOn;
      // getMedia also obtains audio; switching cameras must not leave an extra mic open.
      stream.getAudioTracks().forEach(function (t) { t.stop(); });
      localStream.getVideoTracks().forEach(function (t) { localStream.removeTrack(t); t.stop(); });
      localStream.addTrack(newTrack);
      watchMediaTracks();
      syncMediaControls();
      localVideo.srcObject = localStream;
      preview.srcObject = localStream;
      Object.keys(conns).forEach(function (id) {
        var pc = conns[id].pc;
        pc.getSenders().forEach(function (s) {
          if (s.track && s.track.kind === 'video') s.replaceTrack(newTrack).catch(function () {});
        });
      });
      showToast(facing === 'user' ? 'Front camera' : 'Rear camera');
    }).catch(function (err) {
      showToast('Could not switch camera: ' + err.message);
    });
  });

  shareBtn.addEventListener('click', function () {
    if (screenStream) {
      screenStream.getTracks().forEach(function (t) { t.stop(); });
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      showToast('Screen sharing is not available on this device');
      return;
    }
    navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }).then(function (stream) {
      screenStream = stream;
      var track = stream.getVideoTracks()[0];
      Object.keys(conns).forEach(function (id) {
        var pc = conns[id].pc;
        var replaced = false;
        pc.getSenders().forEach(function (s) {
          if (s.track && s.track.kind === 'video') {
            s.replaceTrack(track).catch(function () {});
            replaced = true;
          }
        });
        if (!replaced) pc.addTrack(track, stream);
      });
      localVideo.srcObject = stream;
      shareBtn.classList.add('off');
      track.onended = function () {
        screenStream = null;
        shareBtn.classList.remove('off');
        restoreCamera();
      };
      showToast('Sharing your screen');
    }).catch(function (err) {
      if (err && err.name !== 'NotAllowedError') showToast('Screen share failed');
    });
  });

  function restoreCamera() {
    if (!localStream) { shareBtn.classList.remove('off'); return; }
    var camTrack = localStream.getVideoTracks()[0];
    if (camTrack) {
      localVideo.srcObject = localStream;
      Object.keys(conns).forEach(function (id) {
        conns[id].pc.getSenders().forEach(function (s) {
          if (s.track && s.track.kind === 'video') s.replaceTrack(camTrack).catch(function () {});
        });
      });
    }
    shareBtn.classList.remove('off');
  }

  var inviteLinkInput = document.getElementById('invite-link');
  function fillInviteLink() {
    if (inviteLinkInput) inviteLinkInput.value = window.location.href;
  }

  function copyLink(el) {
    var url = window.location.href;
    if (inviteLinkInput) inviteLinkInput.value = url;
    function markCopied() {
      var old = el.textContent;
      el.textContent = 'Copied!';
      setTimeout(function () { el.textContent = old; }, 1500);
      showToast('Invite link copied');
    }
    function selectForManualCopy() {
      if (inviteLinkInput) {
        inviteLinkInput.focus();
        inviteLinkInput.select();
        showToast('Copy was blocked. Invite link selected — copy it now.');
      } else {
        showToast('Copy was blocked. Use your browser address bar to share this link.');
      }
    }
    function legacyCopy() {
      var field = inviteLinkInput;
      var temporary = false;
      if (!field) {
        field = document.createElement('textarea');
        field.value = url;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.appendChild(field);
        temporary = true;
      }
      field.focus();
      field.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      if (temporary) document.body.removeChild(field);
      if (ok) markCopied();
      else selectForManualCopy();
      return ok;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(url).then(function () {
        markCopied();
        return true;
      }).catch(function () {
        return legacyCopy();
      });
    }
    return Promise.resolve(legacyCopy());
  }

  copyBtn.addEventListener('click', function () {
    if (navigator.share) {
      navigator.share({ title: 'Join my video call', url: window.location.href }).then(function () {
        showToast('Invite shared');
      }).catch(function (err) {
        if (!err || err.name !== 'AbortError') copyLink(copyBtn);
      });
      return;
    }
    copyLink(copyBtn);
  });
  if (navigator.share) { copyWaitBtn.textContent = 'Share invite link'; }
  copyWaitBtn.addEventListener('click', function () {
    if (navigator.share) {
      navigator.share({ title: 'Join my video call', url: window.location.href }).then(function () {
        showToast('Invite shared');
      }).catch(function (err) {
        if (!err || err.name !== 'AbortError') copyLink(copyWaitBtn);
      });
      return;
    }
    copyLink(copyWaitBtn);
  });

  function cleanup() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    stopStream();
    Object.keys(conns).forEach(function (id) {
      try { conns[id].pc.close(); } catch (e) { /* ignore */ }
    });
    conns = {};
    // The explicit leave is already confirmed; suppress the separate unload warning.
    remoteOrder = [];
    if (localStream) localStream.getTracks().forEach(function (t) { t.stop(); });
    if (screenStream) screenStream.getTracks().forEach(function (t) { t.stop(); });
    if (peerId) post('/leave', { peerId: peerId }, true);
  }

  leaveBtn.addEventListener('click', function () {
    var connected = statusBar && /^In call/.test(statusBar.textContent || '');
    if (connected && !window.confirm('Leave this call? The other person will stay in the room.')) return;
    cleanup();
    window.location.href = '/';
  });

  // Keyboard shortcuts: M mic, V camera, L leave. Reuses the button handlers.
  // Ignored while typing in a field or when a modifier key is held.
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    var key = (e.key || '').toLowerCase();
    if (key === 'm') { e.preventDefault(); micBtn.click(); }
    else if (key === 'v') { e.preventDefault(); camBtn.click(); }
    else if (key === 'l') { e.preventDefault(); leaveBtn.click(); }
  });

  window.addEventListener('pagehide', function () {
    if (peerId) post('/leave', { peerId: peerId }, true);
    if (localStream) localStream.getTracks().forEach(function (t) { t.stop(); });
  });

  setStatus('Lobby');
})();
