(function () {
  var form = document.getElementById('create-form');
  var btn = document.getElementById('create-btn');
  var result = document.getElementById('result');
  var shareLink = document.getElementById('share-link');
  var copyBtn = document.getElementById('copy-btn');
  var enterBtn = document.getElementById('enter-btn');
  var waBtn = document.getElementById('wa-btn');
  var recentList = document.getElementById('recent-list');

  var nameInput = document.getElementById('host-name');
  try {
    var saved = window.localStorage.getItem('linkup:name');
    if (saved) nameInput.value = saved;
  } catch (e) { /* storage may be blocked */ }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var hostName = nameInput.value.trim() || 'Host';
    var title = document.getElementById('room-title').value.trim() || 'Untitled meeting';
    var passcode = document.getElementById('room-passcode').value.trim();
    try { window.localStorage.setItem('linkup:name', hostName); } catch (e) { /* ignore */ }

    btn.disabled = true;
    btn.querySelector('span').textContent = 'Creating…';

    fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title, hostName: hostName, passcode: passcode || undefined })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.roomId) throw new Error(data && data.error ? data.error : 'Failed');
        var url = window.location.origin + '/r/' + data.roomId;
        shareLink.value = url;
        enterBtn.href = url;
        var msg = 'Join my call "' + title + '": ' + url;
        waBtn.href = 'https://wa.me/?text=' + encodeURIComponent(msg);
        waBtn.onclick = function (e) {
          if (navigator.share) {
            e.preventDefault();
            navigator.share({ title: title, text: msg, url: url }).catch(function () { /* cancelled */ });
          }
        };
        result.classList.remove('hidden');
        result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        loadRecent();
      })
      .catch(function (err) {
        alert('Could not create the room: ' + err.message);
      })
      .finally(function () {
        btn.disabled = false;
        btn.querySelector('span').textContent = 'Create call link';
      });
  });

  copyBtn.addEventListener('click', function () {
    copyText(shareLink.value, copyBtn);
  });

  function copyText(text, el) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        flash(el);
      }).catch(function () { fallback(); });
    } else {
      fallback();
    }
    function fallback() {
      shareLink.select();
      try { document.execCommand('copy'); } catch (e) { /* ignore */ }
      flash(el);
    }
  }

  function flash(el) {
    var old = el.textContent;
    el.textContent = 'Copied!';
    setTimeout(function () { el.textContent = old; }, 1400);
  }

  function loadRecent() {
    fetch('/api/recent')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.rooms || !data.rooms.length) {
          recentList.innerHTML = '<p class="fine">No rooms yet — create the first one.</p>';
          return;
        }
        recentList.innerHTML = '';
        data.rooms.forEach(function (room) {
          var a = document.createElement('a');
          a.className = 'recent-item';
          a.href = '/r/' + room.id;
          var t = document.createElement('span');
          t.className = 't';
          t.textContent = room.title;
          var m = document.createElement('span');
          m.className = 'm';
          m.textContent = 'by ' + room.hostName;
          a.appendChild(t);
          a.appendChild(m);
          recentList.appendChild(a);
        });
      })
      .catch(function () {
        recentList.innerHTML = '<p class="fine">Could not load rooms.</p>';
      });
  }

  loadRecent();
})();
