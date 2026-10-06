/* Shared behavior for the project reel pages. Vanilla, no dependencies.
   Each feature checks for its markup and browser support first. */

(function () {
  'use strict';

  var hasIO = 'IntersectionObserver' in window;
  var reduce = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false };

  function each(list, fn) {
    Array.prototype.forEach.call(list, fn);
  }

  function onMotionChange(fn) {
    if (reduce.addEventListener) reduce.addEventListener('change', fn);
    else if (reduce.addListener) reduce.addListener(fn);
  }

  function mediaBox(el) {
    return (el.closest && el.closest('.reel-media')) || el.parentElement;
  }

  function makeToggle(box) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'reel-toggle';
    box.appendChild(btn);
    return btn;
  }

  /* 1. LOOP CLIPS ------------------------------------------------ */
  var clips = document.querySelectorAll('video[data-loop]');

  // Without IntersectionObserver, clips keep their native controls.
  if (hasIO && clips.length) {
    var visible = new Set();
    var clipCtl = new Map();   // video → { sync, label }

    var clipIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var v = e.target;
        // ratio, not isIntersecting, which is true at 1px
        if (e.intersectionRatio >= 0.34) {
          visible.add(v);
        } else {
          visible.delete(v);
          delete v.dataset.userPlayed;   // an explicit Play lasts until it leaves
        }
        clipCtl.get(v).sync();
      });
    // 0.3 forces a callback below 0.34 (leaving clips report ~0.345)
    }, { threshold: [0, 0.3, 0.35] });

    each(clips, function (v) {
      var box = mediaBox(v);
      var btn = makeToggle(box);

      function label() {
        var name = v.dataset.label || v.getAttribute('aria-label') || 'clip';
        btn.textContent = v.paused ? 'Play' : 'Pause';
        btn.setAttribute('aria-label', (v.paused ? 'Play: ' : 'Pause: ') + name);
        // is-held: paused on purpose or autoplay refused (iOS Low Power Mode)
        box.classList.toggle('is-held', v.paused &&
          (reduce.matches || !!v.dataset.userPaused || !!v.dataset.blocked));
      }

      function sync() {
        // Play overrides reduced motion; Pause overrides scrolling into view
        var want = visible.has(v) && !document.hidden && !v.dataset.userPaused &&
          (!reduce.matches || !!v.dataset.userPlayed);
        if (want && v.paused) {
          var p = v.play();
          if (p && p.catch) p.catch(function () { v.dataset.blocked = '1'; label(); });
        } else if (!want && !v.paused) {
          v.pause();
        }
      }

      v.autoplay = false;      // reel.js owns playback
      v.muted = true;          // required for inline autoplay (iOS)
      v.controls = false;      // markup ships controls as the no-JS fallback

      btn.addEventListener('click', function () {
        if (v.paused) {
          delete v.dataset.userPaused;
          delete v.dataset.blocked;
          v.dataset.userPlayed = '1';
          var p = v.play();
          // still refused (e.g. data saver): hand over native controls
          if (p && p.catch) p.catch(function () { v.controls = true; });
        } else {
          delete v.dataset.userPlayed;
          v.dataset.userPaused = '1';
          v.pause();
        }
      });

      v.addEventListener('play', label);
      v.addEventListener('pause', label);
      label();
      clipCtl.set(v, { sync: sync, label: label });
      clipIO.observe(v);
    });

    onMotionChange(function () {
      clipCtl.forEach(function (c) { c.sync(); c.label(); });
    });
    document.addEventListener('visibilitychange', function () {
      clipCtl.forEach(function (c) { c.sync(); });
    });
  }

  /* 2. ANIMATED IMAGES ------------------------------------------- */
  // <img data-still> in a <picture> whose reduced-motion source is the still
  var anims = [];

  each(document.querySelectorAll('.reel-media img[data-still]'), function (img) {
    var anim = img.getAttribute('src');
    var still = img.getAttribute('data-still');
    if (!anim || !still) return;

    var box = mediaBox(img);
    var btn = makeToggle(box);
    var held = false;

    function render() {
      var want = held ? still : anim;
      // only reassign on change; re-setting src restarts the loop
      if (img.getAttribute('src') !== want) img.setAttribute('src', want);
      btn.style.display = reduce.matches ? 'none' : '';
      btn.textContent = held ? 'Play' : 'Pause';
      btn.setAttribute('aria-label', (held ? 'Play: ' : 'Pause: ') + (img.alt || 'animation'));
      box.classList.toggle('is-held', held && !reduce.matches);
    }

    btn.addEventListener('click', function () {
      held = !held;
      render();
    });

    render();
    anims.push(render);
  });

  if (anims.length) {
    onMotionChange(function () { anims.forEach(function (r) { r(); }); });
  }

  /* 3. SCROLL FOCUS ---------------------------------------------- */
  if (hasIO) {
    var focusIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { e.target.classList.toggle('is-live', e.isIntersecting); });
    }, { rootMargin: '-40% 0px -40% 0px' });
    each(document.querySelectorAll('.reel-block'), function (b) { focusIO.observe(b); });
  }

  /* 4. LIVE EMBEDS ----------------------------------------------- */
  each(document.querySelectorAll('.reel-live'), function (box) {
    var gate = box.querySelector('.reel-live-gate');
    var frame = box.querySelector('iframe');
    if (!gate || !frame) return;

    // Backup for the inline onload fade-in. Click-to-load frames
    // (data-src) have no src yet, so their blank load is ignored.
    function markLoaded() { if (frame.getAttribute('src')) frame.classList.add('is-loaded'); }
    frame.addEventListener('load', markLoaded);
    try {
      var doc = frame.contentDocument;
      if (doc && doc.readyState === 'complete' && doc.URL !== 'about:blank') markLoaded();
    } catch (err) { /* cross-origin: the load listener covers it */ }

    function lock() { box.classList.remove('is-active'); }

    gate.addEventListener('click', function () {
      if (!frame.getAttribute('src') && frame.dataset.src) frame.src = frame.dataset.src;
      box.classList.add('is-active');
      try { frame.focus(); } catch (err) { /* focus is best effort */ }
    });
    box.addEventListener('mouseleave', lock);

    if (hasIO) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { if (!e.isIntersecting) lock(); });
      }).observe(box);
    }
  });

  /* 5. VIDEO FACADES --------------------------------------------- */
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a.reel-yt') : null;
    if (!a) return;
    var yt = a.dataset.yt, vm = a.dataset.vimeo;
    if (!yt && !vm) return;   // plain link: let it navigate
    e.preventDefault();

    var f = document.createElement('iframe');
    f.src = yt
      ? 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(yt) + '?autoplay=1&rel=0&playsinline=1'
      : 'https://player.vimeo.com/video/' + encodeURIComponent(vm) + '?autoplay=1&dnt=1';
    f.title = a.getAttribute('aria-label') || 'Video';
    f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    f.referrerPolicy = 'strict-origin-when-cross-origin';

    if (a.replaceWith) a.replaceWith(f);
    else a.parentNode.replaceChild(f, a);
    f.focus();
  });

  /* 6. ZOOM ------------------------------------------------------ */
  // One shared viewer. Without <dialog> support, links just open the file.
  var zoomLinks = document.querySelectorAll('a[data-zoom]');
  var dlg = (zoomLinks.length || clips.length) ? document.createElement('dialog') : null;
  if (dlg && typeof dlg.showModal === 'function') {
    dlg.className = 'reel-zoom';
    dlg.setAttribute('aria-label', 'Enlarged image');
    // static markup only, nothing from the page is interpolated
    dlg.innerHTML =
      '<div class="reel-zoom-stage"><img class="reel-zoom-img" alt="">' +
        '<video class="reel-zoom-vid" muted loop playsinline preload="none"></video></div>' +
      '<div class="reel-zoom-bar">' +
        '<button class="reel-zoom-prev" type="button" aria-label="Previous image">←</button>' +
        '<p class="reel-zoom-cap" aria-live="polite"></p>' +
        '<span class="reel-zoom-count"></span>' +
        '<button class="reel-zoom-next" type="button" aria-label="Next image">→</button>' +
        '<button class="reel-zoom-fit" type="button" aria-pressed="false">1:1</button>' +
        '<button class="reel-zoom-close" type="button" aria-label="Close">×</button>' +
      '</div>';
    document.body.appendChild(dlg);

    function part(cls) { return dlg.querySelector('.reel-zoom-' + cls); }
    var closeBtn = part('close'), stage = part('stage'), big = part('img');
    var cap = part('cap'), count = part('count'), fitBtn = part('fit');
    var prevBtn = part('prev'), nextBtn = part('next');
    var vid = part('vid'), bar = part('bar');
    big.decoding = 'async';

    var groups = new Map();   // data-zoom-group → its links
    var set = [];             // links of the open group
    var at = 0;               // index of the shown link in set
    var opener = null;        // focus returns here on close

    each(zoomLinks, function (a) {
      var g = a.getAttribute('data-zoom-group');
      if (!g) return;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(a);
    });

    // clips step through the other clips in their block
    var clipGroups = new Map();
    each(clips, function (v) {
      var block = v.closest('.reel-block') || v.parentElement;
      if (!clipGroups.has(block)) clipGroups.set(block, []);
      clipGroups.get(block).push(v);
    });

    function isClip(el) { return el.tagName === 'VIDEO'; }

    function clipSrc(v) {
      var s = v.querySelector('source');
      return v.currentSrc || (s && s.src) || v.src;
    }

    // "Block title — tile label"
    function clipCaption(v) {
      var block = v.closest('.reel-block');
      var b = block && block.querySelector('.reel-cap b');
      var tile = v.closest('.reel-tile');
      var lab = tile && tile.querySelector('.reel-tile-label');
      var t1 = b ? b.textContent.trim() : '';
      var t2 = lab ? lab.textContent.replace(/\s+/g, ' ').trim() : '';
      if (t2 && t2.toLowerCase() === t1.toLowerCase()) t2 = '';
      return [t1, t2].filter(Boolean).join(' — ') ||
        v.dataset.label || v.getAttribute('aria-label') || '';
    }

    function stopClip() {
      if (!vid.getAttribute('src')) return;
      vid.pause();
      vid.removeAttribute('src');
      vid.load();   // drop the buffered clip
    }

    // Feed the bar's height to --zoom-bar. Measured twice, since the
    // media's new size can re-wrap the caption.
    function fitBar() {
      dlg.style.removeProperty('--zoom-bar');
      requestAnimationFrame(function () {
        if (!dlg.open) return;
        dlg.style.setProperty('--zoom-bar', bar.offsetHeight + 'px');
        requestAnimationFrame(function () {
          if (dlg.open) dlg.style.setProperty('--zoom-bar', bar.offsetHeight + 'px');
        });
      });
    }

    // drawn smaller than its natural size (+1 absorbs subpixel rounding)
    function scaledDown() {
      return big.complete && big.naturalWidth > 0 &&
        (big.naturalWidth > big.clientWidth + 1 || big.naturalHeight > big.clientHeight + 1);
    }

    // an image that already fits gets no zoom cursor and no 1:1 button
    function setCursor() {
      if (dlg.classList.contains('is-clip')) {
        fitBtn.style.display = '';
        fitBtn.textContent = vid.paused ? 'Play' : 'Pause';
        fitBtn.setAttribute('aria-label', vid.paused ? 'Play clip' : 'Pause clip');
        fitBtn.removeAttribute('aria-pressed');
        return;
      }
      var actual = dlg.classList.contains('is-actual');
      var canToggle = actual || scaledDown();
      big.style.cursor = canToggle ? '' : 'default';
      fitBtn.style.display = canToggle ? '' : 'none';
      fitBtn.textContent = actual ? 'Fit' : '1:1';
      fitBtn.setAttribute('aria-pressed', actual ? 'true' : 'false');
      fitBtn.setAttribute('aria-label', actual ? 'Fit to screen' : 'Show actual size');
    }

    function fit() {
      // the stage stops being focusable once it fits; keep focus in the dialog
      if (document.activeElement === stage) closeBtn.focus();
      dlg.classList.remove('is-actual');
      stage.scrollTop = stage.scrollLeft = 0;
    }

    // switch to actual size, keeping point (px, py) fixed on screen
    function toActual(px, py) {
      var r = big.getBoundingClientRect();
      var fx = (px - r.left) / r.width;
      var fy = (py - r.top) / r.height;
      dlg.classList.add('is-actual');
      var r2 = big.getBoundingClientRect();
      stage.scrollLeft += r2.left + fx * r2.width - px;
      stage.scrollTop += r2.top + fy * r2.height - py;
    }

    function preload(a) {
      if (isClip(a)) return;
      if (!(navigator.connection && navigator.connection.saveData)) new Image().src = a.href;
    }

    function show(i) {
      var n = set.length;
      at = (i % n + n) % n;   // wrap both ways
      var a = set[at];
      fit();
      var clip = isClip(a);
      dlg.classList.toggle('is-clip', clip);
      if (clip) {
        big.removeAttribute('src');
        big.alt = '';
        vid.setAttribute('width', a.getAttribute('width') || '');
        vid.setAttribute('height', a.getAttribute('height') || '');
        vid.poster = a.poster || '';
        vid.src = clipSrc(a);
        vid.setAttribute('aria-label', a.dataset.label || a.getAttribute('aria-label') || '');
        cap.textContent = clipCaption(a);
        // reduced motion: wait for Play
        if (!reduce.matches) {
          var p = vid.play();
          if (p && p.catch) p.catch(function () { setCursor(); });
        }
      } else {
        stopClip();
        var thumb = a.querySelector('img');
        var alt = thumb ? thumb.alt : '';
        big.src = a.href;
        big.alt = alt;
        cap.textContent = a.getAttribute('data-caption') || alt;
      }
      count.textContent = (at + 1) + ' / ' + n;
      setCursor();
      fitBar();
      if (n > 1) preload(set[(at + 1) % n]);
      if (n > 2) preload(set[(at - 1 + n) % n]);
    }

    function open(a) {
      if (isClip(a)) {
        set = clipGroups.get(a.closest('.reel-block') || a.parentElement) || [a];
      } else {
        var g = a.getAttribute('data-zoom-group');
        set = (g && groups.get(g)) || [a];
      }
      opener = a;
      [prevBtn, nextBtn, count].forEach(function (el) {
        el.style.display = set.length > 1 ? '' : 'none';
      });
      show(set.indexOf(a));
      dlg.showModal();
      setCursor();   // re-measure now that it's laid out
      closeBtn.focus();
    }

    each(zoomLinks, function (a) {
      a.addEventListener('click', function (e) {
        // let modified clicks open a new tab / window
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button) return;
        e.preventDefault();
        open(a);
      });
    });

    // clips drawn well below their viewable size become zoom buttons
    function markClips() {
      each(clips, function (v) {
        var w = +v.getAttribute('width') || v.videoWidth;
        var room = Math.min(w, window.innerWidth * 0.96 - 2);
        // not while using the native-controls fallback
        var can = !v.controls && !!w && v.clientWidth > 0 && v.clientWidth < room * 0.85;
        if (can === v.classList.contains('can-zoom')) return;
        if (!v.dataset.label) v.dataset.label = v.getAttribute('aria-label') || 'clip';
        v.classList.toggle('can-zoom', can);
        if (can) {
          v.tabIndex = 0;
          v.setAttribute('role', 'button');
          v.setAttribute('aria-label', 'Enlarge: ' + v.dataset.label);
        } else {
          v.removeAttribute('tabindex');
          v.removeAttribute('role');
          v.setAttribute('aria-label', v.dataset.label);
        }
      });
    }

    each(clips, function (v) {
      v.addEventListener('click', function () {
        if (v.classList.contains('can-zoom')) open(v);
      });
      v.addEventListener('keydown', function (e) {
        if (!v.classList.contains('can-zoom')) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(v); }
      });
    });
    markClips();
    var markQueued = false;
    window.addEventListener('resize', function () {
      if (markQueued) return;
      markQueued = true;
      requestAnimationFrame(function () { markQueued = false; markClips(); });
    });

    vid.addEventListener('click', function () {
      if (vid.paused) { var p = vid.play(); if (p && p.catch) p.catch(function () {}); }
      else vid.pause();
    });
    vid.addEventListener('play', setCursor);
    vid.addEventListener('pause', setCursor);

    closeBtn.addEventListener('click', function () { dlg.close(); });   // Esc closes natively
    prevBtn.addEventListener('click', function () { show(at - 1); });
    nextBtn.addEventListener('click', function () { show(at + 1); });

    dlg.addEventListener('keydown', function (e) {
      if (set.length < 2 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      // on the actual-size stage, arrows pan the image
      if (e.target === stage && dlg.classList.contains('is-actual')) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); show(at - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); show(at + 1); }
    });

    // Backdrop click. The press must start there too, so dragging a
    // text selection out of the caption doesn't close the viewer.
    var downOnBackdrop = false;
    dlg.addEventListener('pointerdown', function (e) { downOnBackdrop = e.target === dlg; });
    dlg.addEventListener('click', function (e) {
      if (e.target === dlg && downOnBackdrop) dlg.close();
    });

    big.addEventListener('click', function (e) {
      if (dlg.classList.contains('is-actual')) fit();
      else if (scaledDown()) toActual(e.clientX, e.clientY);
      setCursor();
    });

    fitBtn.addEventListener('click', function () {
      if (dlg.classList.contains('is-clip')) {
        if (vid.paused) { var p = vid.play(); if (p && p.catch) p.catch(function () {}); }
        else vid.pause();
        return;
      }
      if (dlg.classList.contains('is-actual')) {
        fit();
      } else if (scaledDown()) {
        var r = big.getBoundingClientRect();
        toActual(r.left + r.width / 2, r.top + r.height / 2);
      }
      setCursor();
    });

    big.addEventListener('load', function () { setCursor(); fitBar(); });
    vid.addEventListener('loadedmetadata', fitBar);
    window.addEventListener('resize', function () { if (dlg.open) { setCursor(); fitBar(); } });

    dlg.addEventListener('close', function () {
      fit();
      stopClip();
      dlg.classList.remove('is-clip');
      big.removeAttribute('src');   // next open doesn't flash this image first
      if (opener) opener.focus();
      opener = null;
    });
  }

  /* 7. DOCUMENT READER ------------------------------------------- */
  // With <dialog>, the frame becomes a non-scrolling preview whose cover
  // opens a full-screen reader. Without it, the frame just scrolls.
  each(document.querySelectorAll('.reel-reader'), function (box) {
    var bar = box.querySelector('.reel-reader-bar');
    var view = box.querySelector('.reel-reader-view');
    var pages = box.querySelector('.reel-reader-pages');
    if (!bar || !view || !pages) return;
    var n = pages.querySelectorAll('img').length;
    if (!n) return;
    var titleEl = box.querySelector('.reel-reader-title');
    var title = titleEl ? titleEl.textContent : 'Document';

    // the page crossing a line 35% down the frame
    function current(sc) {
      var list = sc.querySelectorAll('img');
      var line = sc.scrollTop + sc.clientHeight * 0.35;
      var i = 0;
      for (var k = 0; k < list.length; k++) if (list[k].offsetTop <= line) i = k;
      return i;
    }

    // 8px is less than the page gap, so the previous page never peeks in
    function goTo(sc, i) {
      var p = sc.querySelectorAll('img')[i];
      if (p) sc.scrollTop = p.offsetTop - 8;
    }

    // "Page n / N" counter, updated at most once per frame
    function track(sc, countEl, onPage) {
      var queued = false;
      function update() {
        queued = false;
        var i = current(sc);
        if (countEl) countEl.textContent = 'Page ' + (i + 1) + ' / ' + n;
        if (onPage) onPage(i);
      }
      sc.addEventListener('scroll', function () {
        if (queued) return;
        queued = true;
        requestAnimationFrame(update);
      }, { passive: true });
      update();
      return update;
    }

    var full = document.createElement('dialog');
    if (typeof full.showModal !== 'function') {
      track(pages, box.querySelector('.reel-reader-count'));
      return;
    }
    box.classList.add('is-enhanced');
    pages.removeAttribute('tabindex');   // preview no longer scrolls

    // static markup only; title and pages are added as text / clones
    full.className = 'reel-reader-dialog';
    full.setAttribute('aria-label', title);
    full.innerHTML =
      '<div class="reel-reader-bar">' +
        '<span class="reel-reader-title"></span>' +
        '<span class="reel-reader-count"></span>' +
        '<button class="reel-reader-btn reel-reader-close" type="button" aria-label="Close">×</button>' +
      '</div>' +
      '<div class="reel-reader-pages" tabindex="0" role="region"></div>';
    var fullBar = full.querySelector('.reel-reader-bar');
    var fullPages = full.querySelector('.reel-reader-pages');
    var closeBtn = full.querySelector('.reel-reader-close');
    full.querySelector('.reel-reader-title').textContent = title;
    fullPages.setAttribute('aria-label', pages.getAttribute('aria-label') || title);
    each(bar.querySelectorAll('a'), function (a) {   // the PDF link, next to Close
      fullBar.insertBefore(a.cloneNode(true), closeBtn);
    });
    // clone pages on first open so an unopened reader costs no downloads
    var built = false;
    function build() {
      if (built) return;
      built = true;
      each(pages.querySelectorAll('img'), function (img) {
        fullPages.appendChild(img.cloneNode(false));
      });
    }
    document.body.appendChild(full);
    var fullAt = 0;   // last page shown; can't be measured after close
    var updateFull = track(fullPages, full.querySelector('.reel-reader-count'),
      function (i) { fullAt = i; });

    // accessible name starts with the visible chip text (speech input)
    var tap = document.createElement('button');
    tap.type = 'button';
    tap.className = 'reel-reader-tap';
    var chip = document.createElement('span');
    chip.className = 'reel-chip';
    chip.textContent = 'Read full screen · ' + n + (n === 1 ? ' page' : ' pages');
    var more = document.createElement('span');
    more.className = 'sr-only';
    more.textContent = ' — ' + title;
    tap.appendChild(chip);
    tap.appendChild(more);
    view.appendChild(tap);

    var openW = 0;

    tap.addEventListener('click', function () {
      build();
      openW = window.innerWidth;
      full.showModal();
      goTo(fullPages, current(pages));
      updateFull();
      fullPages.focus();   // arrow / Page keys scroll straight away
    });

    closeBtn.addEventListener('click', function () { full.close(); });   // Esc closes natively

    // re-anchor on width changes (rotation), not mobile URL bar resizes
    window.addEventListener('resize', function () {
      if (!full.open || window.innerWidth === openW) return;
      openW = window.innerWidth;
      goTo(fullPages, fullAt);
    });

    // sync the preview to where the reader left off
    full.addEventListener('close', function () {
      goTo(pages, fullAt);
      tap.focus();
      box.scrollIntoView({ block: 'nearest' });
    });
  });

  /* 8. ARCHIVE COUNT --------------------------------------------- */
  // fills [data-count] with the photo count, e.g. "— 12 photos"
  each(document.querySelectorAll('.reel-archive'), function (box) {
    var grid = box.querySelector('.reel-archive-grid') || box;
    var n = grid.querySelectorAll('a[data-zoom]').length;
    if (!n) return;   // empty archive: leave the summary as written
    each(box.querySelectorAll('[data-count]'), function (el) {
      el.textContent = '— ' + n + (n === 1 ? ' photo' : ' photos');
    });
  });
})();
