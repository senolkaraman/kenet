// Transparent, click-through, always-on-top overlay: renders strokes the remote viewer draws
// directly onto this machine's real screen (so it's visible to whoever is sitting here, and gets
// picked up by the outgoing screen-share capture too, so the viewer sees it land on their own copy).
(function () {
  var canvas = document.getElementById("c");
  var ctx = canvas.getContext("2d");
  var dpr = window.devicePixelRatio || 1;
  var strokes = new Map(); // strokeId -> { points: [{x,y}], endedAt: number|null }

  var HOLD_MS = 700; // fully visible for this long after the stroke ends
  var FADE_MS = 1800; // then eases out over this long

  function fit() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", fit);
  fit();

  function drawStroke(points, alpha) {
    if (points.length < 1 || alpha <= 0) return;
    var w = window.innerWidth;
    var h = window.innerHeight;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    // A dark halo first so the stroke reads over any background color underneath it.
    ctx.beginPath();
    ctx.moveTo(points[0].x * w, points[0].y * h);
    for (var i = 1; i < points.length; i++) ctx.lineTo(points[i].x * w, points[i].y * h);
    ctx.strokeStyle = "rgba(0,0,0," + 0.45 * alpha + ")";
    ctx.lineWidth = 7;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(points[0].x * w, points[0].y * h);
    for (var j = 1; j < points.length; j++) ctx.lineTo(points[j].x * w, points[j].y * h);
    ctx.strokeStyle = "rgba(255,71,54," + alpha + ")";
    ctx.lineWidth = 4;
    ctx.stroke();

    // A dot at the leading point makes a single click/tap visible even with no drag.
    var last = points[points.length - 1];
    ctx.beginPath();
    ctx.arc(last.x * w, last.y * h, 6, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,71,54," + alpha + ")";
    ctx.fill();
  }

  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    var now = performance.now();
    strokes.forEach(function (s, id) {
      var alpha = 1;
      if (s.endedAt != null) {
        var elapsed = now - s.endedAt - HOLD_MS;
        if (elapsed > 0) alpha = Math.max(0, 1 - elapsed / FADE_MS);
        if (alpha <= 0) {
          strokes.delete(id);
          return;
        }
      }
      drawStroke(s.points, alpha);
    });
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  window.overlayBridge.onDraw(function (d) {
    if (d.phase === "start") {
      strokes.set(d.strokeId, { points: [{ x: d.x, y: d.y }], endedAt: null });
      return;
    }
    var s = strokes.get(d.strokeId);
    if (!s) return;
    if (d.phase === "move") s.points.push({ x: d.x, y: d.y });
    if (d.phase === "end") s.endedAt = performance.now();
  });
})();
