/* Hero 3D viewer: the model is lit into a small render target, then a
   full-screen pass draws it as the palette dot grid. */

(function () {
  const MODEL_PATH = 'models/40kModel.fbx';
  const MOBILE_BREAKPOINT = 900;

  // preview switches: ?hero=saturn|none|<file>.fbx, ?px=6, ?key=5,3,2
  const QUERY = new URLSearchParams(window.location.search);
  const HERO_PREVIEW = QUERY.get('hero');
  const PREVIEW_PX = parseFloat(QUERY.get('px')) || 0;
  const PREVIEW_KEY = (QUERY.get('key') || '').split(',').map(Number);

  const canvas = document.getElementById('hero-canvas');
  if (!canvas || typeof THREE === 'undefined') return;
  if (HERO_PREVIEW === 'none') {
    const box = canvas.closest('.intro-3d');
    (box || canvas).style.display = 'none';
    return;
  }

  const isMobile = window.innerWidth <= MOBILE_BREAKPOINT;

  // look-at-mouse limits, also used to frame the camera
  const BASE_YAW = 0;
  const MAX_YAW_OFFSET = 0.3;
  const MAX_PITCH_OFFSET = 0.12;

  // ---- Renderer ----

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
  renderer.setPixelRatio(isMobile ? 1 : Math.min(window.devicePixelRatio || 1, 2));

  function getCanvasSize() {
    return { width: canvas.clientWidth || 1, height: canvas.clientHeight || 1 };
  }

  let { width, height } = getCanvasSize();
  renderer.setSize(width, height, false);

  // set when the picture changes without the mesh moving (load, resize)
  let needsDraw = true;

  // ---- Scene pass: the lit mesh, rendered to a render target ----

  const scenePass = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 100);
  camera.position.set(0, 0, 6);
  camera.lookAt(0, 0, 0);

  const keyDir = PREVIEW_KEY.length === 3 && PREVIEW_KEY.every(isFinite) ? PREVIEW_KEY : [3, 4, 5];
  const meshMaterial = new THREE.ShaderMaterial({
    uniforms: { keyDir: { value: new THREE.Vector3(keyDir[0], keyDir[1], keyDir[2]).normalize() } },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
        vViewPosition = viewPos.xyz;
        gl_Position = projectionMatrix * viewPos;
      }
    `,
    fragmentShader: `
      precision mediump float;
      uniform vec3 keyDir;
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      void main() {
        vec3 normal = normalize(vNormal);
        vec3 viewDir = normalize(-vViewPosition);
        vec3 keyLight = keyDir;
        vec3 fillLight = normalize(vec3(-2.0, -1.0, 3.0));

        float diffuse = max(dot(normal, keyLight), 0.0) * 0.85 + max(dot(normal, fillLight), 0.0) * 0.25;
        float specular = pow(max(dot(reflect(-keyLight, normal), viewDir), 0.0), 48.0) * 0.55;
        float rim = pow(1.0 - max(dot(normal, viewDir), 0.0), 4.0) * 0.3;
        float brightness = clamp(diffuse + specular + rim + 0.08, 0.0, 1.0);

        gl_FragColor = vec4(vec3(brightness), 1.0);
      }
    `
  });

  // rotated group: the loaded model or the fallback shape
  const subject = new THREE.Group();
  scenePass.add(subject);

  function createFallbackMesh() {
    const geometry = new THREE.IcosahedronGeometry(1.2, 1);
    return new THREE.Mesh(geometry, meshMaterial);
  }

  const FRONTAL_FIT_SIZE = 4.0;

  // exported facing away from the camera
  const FLIPPED_MODELS = ['models/HelmetDecimated.fbx'];

  // call before parenting, so subject's rotation doesn't skew the box
  function fitAndCenter(object, flip) {
    object.rotation.y = flip ? Math.PI : 0;

    const box = new THREE.Box3().setFromObject(object);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);

    // fit width/height only; depth doesn't need to fill the frame
    const frontalDim = Math.max(size.x, size.y) || 1;
    const scale = FRONTAL_FIT_SIZE / frontalDim;
    object.scale.setScalar(scale);
    object.position.sub(center.multiplyScalar(scale));
  }

  // phone sway amplitude; framing covers whichever range is wider
  const SWAY = 0.35;

  // vertices sampled once after load, for exact framing
  let framePoints = null;

  function collectFramePoints() {
    const rx = subject.rotation.x;
    const ry = subject.rotation.y;
    subject.rotation.set(0, 0, 0);
    subject.updateMatrixWorld(true);
    const pts = [];
    const v = new THREE.Vector3();
    subject.traverse(function (child) {
      if (!child.isMesh) return;
      const pos = child.geometry.attributes.position;
      const step = Math.max(1, Math.floor(pos.count / 4000));
      for (let i = 0; i < pos.count; i += step) {
        pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(child.matrixWorld).clone());
      }
    });
    subject.rotation.set(rx, ry, 0);
    framePoints = pts;
  }

  // keep every sampled point in frame across the rotation range
  function frameCameraForRotationRange() {
    if (!framePoints) collectFramePoints();
    const yawRange = Math.max(MAX_YAW_OFFSET, isMobile ? SWAY : 0);
    const yawSamples = [BASE_YAW - yawRange, BASE_YAW, BASE_YAW + yawRange];
    const pitchSamples = isMobile ? [0] : [-MAX_PITCH_OFFSET, 0, MAX_PITCH_OFFSET];

    const margin = 1.03;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const aspect = camera.aspect || 1;
    const euler = new THREE.Euler();
    const rot = new THREE.Matrix4();
    const p = new THREE.Vector3();
    let need = 0;

    yawSamples.forEach(function (yaw) {
      pitchSamples.forEach(function (pitch) {
        rot.makeRotationFromEuler(euler.set(pitch, yaw, 0));
        for (let i = 0; i < framePoints.length; i++) {
          p.copy(framePoints[i]).applyMatrix4(rot);
          // camera on +Z: distance z + |x| / (tan * aspect) across, z + |y| / tan up
          const forWidth = Math.abs(p.x) * margin / (tanHalf * aspect);
          const forHeight = Math.abs(p.y) * margin / tanHalf;
          need = Math.max(need, p.z + Math.max(forWidth, forHeight));
        }
      });
    });

    camera.position.z = Math.max(need, 1.5);
    camera.lookAt(0, 0, 0);
  }

  function applyMeshMaterial(object) {
    object.traverse(function (child) {
      if (child.isMesh) child.material = meshMaterial;
    });
  }

  // Saturn from the raymarch sketch (preview only)
  function createSaturn() {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), meshMaterial));
    const ringMaterial = meshMaterial.clone();
    ringMaterial.side = THREE.DoubleSide;
    const rings = new THREE.Group();
    [[1.6, 1.85], [2.05, 2.35]].forEach(function (r) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(r[0], r[1], 128, 1), ringMaterial);
      ring.rotation.x = -Math.PI / 2; // RingGeometry is built in XY
      rings.add(ring);
    });
    rings.rotation.x = -0.5;
    group.add(rings);
    return group;
  }

  function loadSubject() {
    const path = /^[\w-]+\.(fbx|obj)$/i.test(HERO_PREVIEW || '') ? 'models/' + HERO_PREVIEW : MODEL_PATH;
    if (HERO_PREVIEW === 'saturn') {
      const saturn = createSaturn();
      fitAndCenter(saturn, false);
      subject.add(saturn);
      frameCameraForRotationRange();
      needsDraw = true;
      return;
    }
    const ext = path.split('.').pop().toLowerCase();
    const onLoad = function (object) {
      applyMeshMaterial(object);
      fitAndCenter(object, FLIPPED_MODELS.indexOf(path) !== -1);
      subject.add(object);
      frameCameraForRotationRange();
      needsDraw = true;
    };
    const onError = function () {
      const fallback = createFallbackMesh();
      fitAndCenter(fallback, false);
      subject.add(fallback);
      frameCameraForRotationRange();
      needsDraw = true;
    };

    if (ext === 'fbx' && typeof THREE.FBXLoader === 'function') {
      new THREE.FBXLoader().load(path, onLoad, undefined, onError);
    } else if (ext === 'obj' && typeof THREE.OBJLoader === 'function') {
      new THREE.OBJLoader().load(path, onLoad, undefined, onError);
    } else {
      onError();
    }
  }

  loadSubject();

  // The post pass reads one sample per dot cell, so the scene renders at one
  // texel per cell, offset so texel (i, j) sits on the center of cell (i, j).
  const PIXEL_SIZE = PREVIEW_PX || (isMobile ? 8.0 : 6.0);

  function cellGrid() {
    return {
      cols: Math.max(1, Math.ceil(width / PIXEL_SIZE)),
      rows: Math.max(1, Math.ceil(height / PIXEL_SIZE))
    };
  }

  function fitCameraToCells() {
    const g = cellGrid();
    const w = g.cols * PIXEL_SIZE;
    const h = g.rows * PIXEL_SIZE;
    // the partial cell row sits at the top
    camera.setViewOffset(width, height, 0, height - h, w, h);
  }

  let sceneRenderTarget = new THREE.WebGLRenderTarget(cellGrid().cols, cellGrid().rows, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter
  });
  fitCameraToCells();

  // ---- Post pass: palette dot grid, scanlines, vignette ----

  const postScene = new THREE.Scene();
  const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const postUniforms = {
    sceneTexture: { value: sceneRenderTarget.texture },
    resolution: { value: new THREE.Vector2(width, height) },
    // 6px keeps the skull readable; phones a bit coarser
    pixelSize: { value: PIXEL_SIZE },
    cells: { value: new THREE.Vector2(cellGrid().cols, cellGrid().rows) },
    time: { value: 0 }
  };

  const postMaterial = new THREE.ShaderMaterial({
    uniforms: postUniforms,
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position, 1.0); }`,
    fragmentShader: `
      precision mediump float;
      uniform sampler2D sceneTexture;
      uniform vec2 resolution, cells;
      uniform float pixelSize, time;
      varying vec2 vUv;

      // site-token ramp by brightness: void → cyan → magenta → ink
      vec3 applyPalette(float b) {
        vec3 voidC = vec3(0.039, 0.043, 0.051);
        vec3 cyan = vec3(0.0, 0.898, 1.0);
        vec3 magenta = vec3(1.0, 0.165, 0.428);
        vec3 ink = vec3(0.925, 0.925, 0.941);

        if (b < 0.33) return mix(voidC, cyan, b * 3.0);
        else if (b < 0.7) return mix(cyan, magenta, (b - 0.33) / 0.37);
        else return mix(magenta, ink, (b - 0.7) / 0.3);
      }

      void main(){
        vec2 cellSize = vec2(pixelSize) / resolution;
        vec2 cellCoord = floor(vUv / cellSize);
        vec2 cellLocalUv = fract(vUv / cellSize);
        vec2 sampleUv = (cellCoord + 0.5) / cells;

        vec4 scenePixel = texture2D(sceneTexture, sampleUv);
        float brightness = scenePixel.r;
        float hit = scenePixel.a;

        float distToCenter = length(cellLocalUv - vec2(0.5));
        vec3 color = vec3(0.0);
        float dotAlpha = 0.0;

        // only the mesh's dots are drawn; the rest stays transparent
        if (hit > 0.5) {
          // max radius under half a cell, so dots never touch
          float dotRadius = brightness * 0.32 + 0.01;
          float dotMask = smoothstep(dotRadius + 0.04, dotRadius - 0.04, distToCenter);
          float glowHalo = smoothstep(dotRadius + 0.12, dotRadius, distToCenter) * 0.18 * (1.0 - dotMask);
          color = applyPalette(brightness) * (dotMask + glowHalo);
          dotAlpha = clamp(dotMask + glowHalo, 0.0, 1.0);
        }

        color *= 1.0 - 0.45 * pow(sin(vUv.y * resolution.y * 3.14159), 2.0);

        vec2 vignetteUv = vUv * 2.0 - 1.0;
        color *= pow(clamp(1.0 - dot(vignetteUv * 0.55, vignetteUv * 0.55), 0.0, 1.0), 1.5);

        gl_FragColor = vec4(clamp(color, 0.0, 1.0), dotAlpha);
      }
    `,
    transparent: true
  });

  postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMaterial));

  // ---- Rotation: desktop follows the mouse, phones sway, reduced motion holds still ----

  const LOOK_EASE = 0.08;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  let rotationY = BASE_YAW;
  let rotationX = 0;
  let targetYawOffset = 0;
  let targetPitchOffset = 0;

  if (!isMobile) {
    window.addEventListener('mousemove', function (e) {
      const nx = (e.clientX / window.innerWidth) * 2 - 1;
      const ny = (e.clientY / window.innerHeight) * 2 - 1;
      targetYawOffset = Math.max(-1, Math.min(1, nx)) * MAX_YAW_OFFSET;
      targetPitchOffset = Math.max(-1, Math.min(1, ny)) * MAX_PITCH_OFFSET;
    });
  }

  // ---- Resize ----

  const resizeObserver = new ResizeObserver(function () {
    const size = getCanvasSize();
    width = size.width;
    height = size.height;

    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (subject.children.length) frameCameraForRotationRange();

    const g = cellGrid();
    sceneRenderTarget.setSize(g.cols, g.rows);
    postUniforms.cells.value.set(g.cols, g.rows);
    fitCameraToCells();
    postUniforms.resolution.value.set(width, height);
    needsDraw = true; // resizing clears the canvas
  });
  resizeObserver.observe(canvas);

  // three.js rebuilds its GPU state after a lost context is restored
  canvas.addEventListener('webglcontextrestored', function () {
    needsDraw = true;
  });

  // ---- Render loop: runs only while the canvas is on screen ----

  let elapsed = 0;
  let frameId = 0;

  function isAnimating() {
    return !reduceMotion.matches;
  }

  // redraw once at the new pose if the OS motion setting changes
  function onMotionPrefChange() { needsDraw = true; }
  if (reduceMotion.addEventListener) reduceMotion.addEventListener('change', onMotionPrefChange);
  else if (reduceMotion.addListener) reduceMotion.addListener(onMotionPrefChange);

  function renderLoop() {
    frameId = requestAnimationFrame(renderLoop);
    if (!isAnimating() && !needsDraw) return;
    const drawNow = needsDraw;
    needsDraw = false;

    elapsed += 0.016;
    postUniforms.time.value = elapsed;

    if (reduceMotion.matches) {
      rotationY = BASE_YAW;
      rotationX = 0;
      subject.rotation.x = rotationX;
    } else if (isMobile) {
      // sway rather than spin: the emblem is flat
      rotationY = BASE_YAW + Math.sin(elapsed * 0.6) * SWAY;
    } else {
      const dy = (BASE_YAW + targetYawOffset - rotationY) * LOOK_EASE;
      const dx = (targetPitchOffset - rotationX) * LOOK_EASE;
      // settled on the cursor: the frame would be identical, so skip it
      if (!drawNow && Math.abs(dy) < 1e-5 && Math.abs(dx) < 1e-5) return;
      rotationY += dy;
      rotationX += dx;
      subject.rotation.x = rotationX;
    }
    subject.rotation.y = rotationY;

    renderer.setRenderTarget(sceneRenderTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scenePass, camera);

    renderer.setRenderTarget(null);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(postScene, orthoCam);
  }

  function startLoop() {
    if (!frameId) frameId = requestAnimationFrame(renderLoop);
  }

  function stopLoop() {
    cancelAnimationFrame(frameId);
    frameId = 0;
  }

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      if (entries[entries.length - 1].isIntersecting) startLoop();
      else stopLoop();
    }).observe(canvas);
  }

  startLoop();
})();
