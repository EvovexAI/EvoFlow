/* Shared runtime: fit-to-viewport + GSAP plugin bootstrap */
(function () {
  function fitRoot() {
    var root = document.getElementById("root");
    if (!root) return;
    // Cover-ish scale so the stage fills the screen and reads larger (center crop).
    var cover = Math.max(window.innerWidth / 1920, window.innerHeight / 1080);
    var contain = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    // Prefer cover, but don't go wildly past contain on ultrawide.
    var s = Math.min(cover, contain * 1.18);
    root.style.transform = "scale(" + s + ")";
  }

  window.EFAnim = {
    avatar: function (id) {
      // Product defaults: 小V → preset:analyst cutout (also shipped as xiaomi.png).
      var aliases = { xiaomi: "xiaomi", "小v": "xiaomi", "小V": "xiaomi" };
      var file = aliases[id] || id;
      return "/animations/_assets/avatars/" + file + ".png";
    },
    fit: fitRoot,
    loop: function (tl) {
      window.__timelines = window.__timelines || {};
      window.__timelines.main = tl;
      if (!window.HyperFrames && !window.__HYPERFRAMES_RUNTIME__) {
        tl.play(0);
        tl.eventCallback("onComplete", function () {
          tl.restart();
        });
      }
    },
    press: function (tl, sel, at) {
      tl.to(sel, { scale: 0.9, duration: 0.1, ease: "power1.in" }, at);
      tl.to(sel, { scale: 1, duration: 0.18, ease: "back.out(2)" }, at + 0.1);
    },
    popIn: function (tl, sel, at) {
      tl.fromTo(
        sel,
        { opacity: 0, scale: 0.82, y: 18 },
        { opacity: 1, scale: 1, y: 0, duration: 0.45, ease: "back.out(1.7)" },
        at
      );
    },
    /** 动画字幕入场（画面内 pill） */
    captionIn: function (tl, sel, at, opts) {
      opts = opts || {};
      var key = !!opts.key;
      tl.call(
        function () {
          var el = document.querySelector(sel);
          if (!el) return;
          el.classList.toggle("is-key", key);
          el.classList.remove("is-enter");
          void el.offsetWidth;
          el.classList.add("is-enter");
        },
        null,
        at
      );
      tl.fromTo(
        sel,
        { opacity: 0 },
        { opacity: 1, duration: 0.12, ease: "power1.out" },
        at
      );
    },
    captionOut: function (tl, sel, at, dur) {
      dur = typeof dur === "number" ? dur : 0.3;
      tl.to(sel, { opacity: 0, duration: dur, ease: "power1.in" }, at);
    },
    /**
     * 口播单句：底部一句口语，到点换下一句。
     * hold = 本句停留秒数（含淡入），下一句会先淡出再换字。
     */
    say: function (tl, sel, text, at, hold) {
      hold = typeof hold === "number" ? hold : 3.2;
      var fade = 0.28;
      tl.call(
        function () {
          var root = document.querySelector(sel);
          if (!root) return;
          var node = root.querySelector(".text") || root;
          root.classList.remove("is-exit", "is-enter");
          void root.offsetWidth;
          node.textContent = text;
          root.classList.add("is-enter");
        },
        null,
        at
      );
      tl.fromTo(
        sel,
        { opacity: 0 },
        { opacity: 1, duration: 0.12, ease: "power1.out" },
        at
      );
      tl.call(
        function () {
          var root = document.querySelector(sel);
          if (!root) return;
          root.classList.remove("is-enter");
          root.classList.add("is-exit");
        },
        null,
        at + Math.max(0.6, hold - fade)
      );
      tl.to(sel, { opacity: 0, duration: fade, ease: "power1.in" }, at + Math.max(0.6, hold - fade));
    },
    /** 兼容旧调用：默认当动画字幕 */
    voIn: function (tl, sel, at, opts) {
      window.EFAnim.captionIn(tl, sel, at, opts);
    },
    voOut: function (tl, sel, at, dur) {
      window.EFAnim.captionOut(tl, sel, at, dur);
    },
  };

  fitRoot();
  window.addEventListener("resize", fitRoot);

  if (window.gsap) {
    if (gsap.registerPlugin) {
      if (window.MotionPathPlugin) gsap.registerPlugin(MotionPathPlugin);
      if (window.TextPlugin) gsap.registerPlugin(TextPlugin);
    }
  }
})();
