// dsh-plugin-noticeme — client bundle (hand-written ModuleLoader form,
// no bundler needed). Long-polls the host queue and raises a desktop
// notification (or a tab-title fallback) only while the page is hidden.
// Long-polling is used because browsers throttle background-tab timers but
// never throttle a pending fetch.
window.__ModuleLoader__.load({ id: 'dsh-plugin-noticeme', factory: function (require) {
  var module = { exports: {} }
  var exports = module.exports

  var TITLE_PREFIX = '⚠ 需要你确认 · '
  var NOTIFY_TAG = 'dsh-noticeme'
  var savedTitle = null
  var stopped = false

  function requestPermission() {
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission().catch(function () {})
      }
    } catch (e) {
      /* ignore */
    }
  }

  function setTitleFlag() {
    try {
      if (document.title.indexOf(TITLE_PREFIX) === 0) return
      if (savedTitle === null) savedTitle = document.title
      document.title = TITLE_PREFIX + document.title
    } catch (e) {
      /* ignore */
    }
  }

  function clearTitleFlag() {
    try {
      if (savedTitle !== null) {
        document.title = savedTitle
        savedTitle = null
      }
    } catch (e) {
      /* ignore */
    }
  }

  function notify(item) {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        var n = new Notification(item.title, {
          body: item.body,
          tag: NOTIFY_TAG,
          requireInteraction: true,
        })
        n.onclick = function () {
          try {
            window.focus()
          } catch (e) {
            /* ignore */
          }
          n.close()
        }
        return
      } catch (e) {
        /* fall through to title flag */
      }
    }
    setTitleFlag()
  }

  function drain() {
    if (stopped) return
    fetch('/dsh-noticeme/wait', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (data) {
        // The user is looking at the page: no notification needed.
        if (data && data.ok && data.items && data.items.length && document.visibilityState !== 'visible') {
          data.items.forEach(notify)
        }
        drain()
      })
      .catch(function () {
        // Transient error: retry shortly; keep the chain alive.
        if (!stopped) setTimeout(drain, 3000)
      })
  }

  exports.apply = function apply(ctx) {
    requestPermission()
    ctx.effect(function () {
      stopped = false
      drain()
      var onVis = function () {
        if (document.visibilityState === 'visible') clearTitleFlag()
      }
      document.addEventListener('visibilitychange', onVis)
      return function () {
        stopped = true
        document.removeEventListener('visibilitychange', onVis)
        clearTitleFlag()
      }
    }, 'dsh-plugin-noticeme: long-poll')
  }

  exports.name = 'dsh-plugin-noticeme'
  exports.inject = []
  return module.exports
}})
