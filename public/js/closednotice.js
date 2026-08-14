// A visible notice when the campaign is closed.
//
// The gate is server-side and correct: every game route answers 403 with a
// reason. But a page that only logs that to a debug panel LOOKS BROKEN — an
// empty scene list, an empty roster, a chat that will not send, and no
// explanation anywhere a person would look. Silent degradation has already cost
// this project real time twice: a dead socket after a server restart, and a
// logged-out session, both of which presented as "the feature stopped working".
//
// So the refusal is surfaced where it happens, on every page that can hit it.
//
// A module rather than markup in three pages, for the same reason the image
// picker is one: three copies of a banner is three copies to keep in step, and
// two of these pages are covered by jsdom suites that assert on the elements
// their markup contains. This adds none.

(function closedNoticeModule() {
  let el = null;

  function ensure() {
    if (el) return el;
    const style = document.createElement('style');
    style.textContent = `
      .vtt-closed-notice {
        position: fixed; top: 0; left: 0; right: 0; z-index: 200;
        background: #a40; color: #fff; font-family: monospace; font-size: 13px;
        padding: 10px 14px; display: none; box-shadow: 0 1px 6px #0006;
      }
      .vtt-closed-notice b { color: #ffd; }
      .vtt-closed-notice .x { float: right; cursor: pointer; opacity: .8; padding: 0 4px; }
    `;
    document.head.appendChild(style);

    el = document.createElement('div');
    el.className = 'vtt-closed-notice';
    document.body.appendChild(el);
    return el;
  }

  // Dismissable, but it comes back on the next refusal — a person who closes it
  // and then clicks something else should be told again rather than left
  // wondering why nothing happened.
  function show(message) {
    const node = ensure();
    node.textContent = '';
    const strong = document.createElement('b');
    strong.textContent = 'This game is closed. ';
    node.appendChild(strong);
    // textContent, never innerHTML: this string comes from the server, and a
    // banner is not a reason to relax the rule the rest of the client follows.
    node.appendChild(document.createTextNode(
      message || 'The GM has not opened it yet. You will be able to play when they do.',
    ));
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.addEventListener('click', () => { node.style.display = 'none'; });
    node.appendChild(x);
    node.style.display = 'block';
  }

  function hide() {
    if (el) el.style.display = 'none';
  }

  // Inspect one API response. Returns true when it was a closed-campaign
  // refusal, so a caller can stop rather than carry on rendering nothing.
  //
  // Matched on the STATUS AND the message, not on status alone: 403 is also
  // what a player gets for trying a GM-only action, and telling them the game
  // is closed when it is open and they simply are not the GM would be worse
  // than saying nothing.
  function check(res) {
    if (!res || res.status !== 403) return false;
    const err = (res.data && res.data.error) || '';
    if (!/closed/i.test(err)) return false;
    show(err);
    return true;
  }

  window.VTTClosedNotice = { check, show, hide };
}());
