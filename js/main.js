
    // ======= same background & interaction code, slightly compressed comments =======
    const fgCanvas = document.getElementById('render-canvas');
    const fgCtx = fgCanvas.getContext('2d');
    const bgCanvas = document.getElementById('bg-canvas');
    const gl = bgCanvas.getContext('webgl', {
      antialias: true,
      powerPreference: "high-performance",
      alpha: false
    });
    // Scanline 逻辑已移至 CSS

    if (!gl) {
      console.error("WebGL not supported.");
      bgCanvas.style.display = 'none';
    }

    let width, height;
    let scrollY = window.scrollY;

    const STAR_COUNT = 40;
    const GRID_SPACING = 120;
    const GRID_DIMENSIONS = 40;
    const GRID_DEPTH_SEGMENTS = GRID_DIMENSIONS / 2;
    const NODE_SIZE = 3.5;

    const stars = [];
    const gridPoints = [];
    const camera = {
      fov: 355,
      y: 0,
      rotationX: 0,
      targetY: 0,
      targetRotationX: 0,
      lerpFactor: 0.07
    };

    function project(p) {
      const cosX = Math.cos(camera.rotationX);
      const sinX = Math.sin(camera.rotationX);
      const translatedY = p.y - camera.y;
      const rotatedY = 41 * translatedY * cosX - 0.1 * p.z * sinX;
      const rotatedZ = 0 * translatedY * sinX + p.z * cosX;
      if (rotatedZ <= 0) return null;
      const scale = camera.fov / rotatedZ;
      return {
        x: width / 2 + p.x * scale,
        y: height / 2 - rotatedY * scale,
        scale,
        z: rotatedZ
      };
    }

    function drawForeground() {
      fgCtx.clearRect(0, 0, width, height);

      // 1. 依然用 2D 画星星 (数量少，开销低)
      fgCtx.fillStyle = '#dce2f0';
      stars.forEach(star => {
        const y = (star.y - scrollY * star.depth + height);
        fgCtx.beginPath();
        fgCtx.arc(star.x, y, star.size, 0, 2 * Math.PI);
        fgCtx.fill();
      });

      // Phase 2: 纯 GPU 渲染路径
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // Additive Blending 增加发光感

      gl.useProgram(gridProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, gridBuffer);
      gl.enableVertexAttribArray(gridPositionLoc);
      // 注意这里是 3 (x,y,z)
      gl.vertexAttribPointer(gridPositionLoc, 3, gl.FLOAT, false, 0, 0);

      // 传递当前帧的相机参数
      gl.uniform1f(gl.getUniformLocation(gridProgram, "u_scrollY"), camera.y);
      gl.uniform1f(gl.getUniformLocation(gridProgram, "u_fov"), camera.fov);
      gl.uniform1f(gl.getUniformLocation(gridProgram, "u_rotationX"), camera.rotationX);
      gl.uniform2f(gridResLoc, width, height);
      gl.uniform4f(gridColorLoc, currentR / 255, currentG / 255, currentB / 255, 0.16);

      gl.drawArrays(gl.LINES, 0, gridPointsCount);

      // --- Phase 3: GPU 渲染节点 ---
      gl.useProgram(window.nodeProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, window.nodeBuffer);
      const nodePosLoc = gl.getAttribLocation(window.nodeProgram, "a_pos3d");
      gl.enableVertexAttribArray(nodePosLoc);
      gl.vertexAttribPointer(nodePosLoc, 3, gl.FLOAT, false, 0, 0);

      gl.uniform1f(gl.getUniformLocation(window.nodeProgram, "u_scrollY"), camera.y);
      gl.uniform1f(gl.getUniformLocation(window.nodeProgram, "u_fov"), camera.fov);
      gl.uniform1f(gl.getUniformLocation(window.nodeProgram, "u_rotationX"), camera.rotationX);
      gl.uniform2f(gl.getUniformLocation(window.nodeProgram, "u_resolution"), width, height);

      const nodeR = (currentR * 0.35 + 80 * 0.65) / 255;
      const nodeG = (currentG * 0.35 + 130 * 0.65) / 255;
      const nodeB = (currentB * 0.35 + 255 * 0.65) / 255;
      gl.uniform3f(gl.getUniformLocation(window.nodeProgram, "u_color"), nodeR, nodeG, nodeB);

      gl.drawArrays(gl.POINTS, 0, window.nodeCount);

      gl.disable(gl.BLEND);
    }

    const vertexShaderSource = `
      attribute vec2 a_position;
      void main() { gl_Position = vec4(a_position, 0.0, 1.0); }`;

    const fragmentShaderSource = `
      precision highp float;
      uniform vec2 u_resolution;
      uniform float u_time;
      uniform vec3 u_color;
      uniform sampler2D u_blueNoise;

      vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
      vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
      vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }

      float snoise(vec2 v) {
        const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                            -0.577350269189626, 0.024390243902439);
        vec2 i  = floor(v + dot(v, C.yy));
        vec2 x0 = v - i + dot(i, C.xx);
        vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
        vec4 x12 = x0.xyxy + C.xxzz;
        x12.xy -= i1;
        i = mod289(i);
        vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0 ))
                        + i.x + vec3(0.0, i1.x, 1.0 ));
        vec3 m = max(0.5 - vec3(
          dot(x0,x0),
          dot(x12.xy,x12.xy),
          dot(x12.zw,x12.zw)
        ), 0.0);
        m = m*m; m = m*m;
        vec3 x = 2.0 * fract(p * C.www) - 1.0;
        vec3 h = abs(x) - 0.5;
        vec3 ox = floor(x + 0.5);
        vec3 a0 = x - ox;
        m *= 1.79284291400159 - 0.85373472095314 *
             ( a0*a0 + h*h );
        vec3 g;
        g.x  = a0.x  * x0.x  + h.x  * x0.y;
        g.yz = a0.yz * x12.xz + h.yz * x12.yw;
        return 130.0 * dot(m, g);
      }

      float fbm(vec2 st) {
        st *= 0.1; st += 0.1;
        float value = 0.0;
        float amplitude = 0.5;
        for (int i = 0; i < 6; i++) {
          value += amplitude * snoise(st);
          st *= 2.0;
          amplitude *= 0.5;
        }
        return value;
      }

      void main() {
        vec2 st = gl_FragCoord.xy / u_resolution.xy;
        st.x *= u_resolution.x / u_resolution.y;
        float t = u_time * 0.6;
        vec2 q = vec2(
          fbm(st + vec2(t*0.2, t*0.1)),
          fbm(st + vec2(-t*0.15, t*0.25))
        );
        vec2 r = vec2(
          fbm(st + q*2.0 + vec2(t*-0.3, t*0.05)),
          fbm(st + q*2.0 + vec2(t*0.1, -t*0.3))
        );
        float value = fbm(st + r*0.5);
        float contrastValue = pow(max(0.0, value), 2.2);
        vec3 finalColor = u_color * contrastValue * 1.5;
        vec3 noise = texture2D(u_blueNoise, gl_FragCoord.xy / 256.0).rgb;
        finalColor += (noise - 0.5) / 128.0;
        gl_FragColor = vec4(clamp(finalColor, 0.0, 1.0), 1.0);
      }`;

    // 必须在全局声明，确保所有函数都能访问到这些“句柄”
    let glProgram,
      positionAttributeLocation,
      resolutionUniformLocation,
      timeUniformLocation,
      colorUniformLocation,
      blueNoiseUniformLocation,
      positionBuffer; // 刚才漏掉的背景顶点缓冲句柄

    // Phase 2: Grid 渲染程序变量
    let gridProgram, gridPositionLoc, gridResLoc, gridColorLoc, gridBuffer;
    let gridPointsCount = 0; // 必须全局声明

    let currentR = 50, currentG = 80, currentB = 220;
    let targetR = 50, targetG = 80, targetB = 220;
    let blueNoiseTexture;

    function createShader(gl, type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error("Shader compile error:", gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    }

    function createProgram(gl, v, f) {
      const program = gl.createProgram();
      gl.attachShader(program, v);
      gl.attachShader(program, f);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error("Program link error:", gl.getProgramInfoLog(program));
        gl.deleteProgram(program);
        return null;
      }
      return program;
    }

    function loadTexture(gl, url) {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA,
        1, 1, 0,
        gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 255])
      );
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.onload = () => {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA,
          gl.RGBA, gl.UNSIGNED_BYTE, image);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      };
      image.src = 'assets/blueNoise.png';
      return texture;
    }

    function setupWebGL() {
      if (!gl) return;
      const vs = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
      const fs = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
      glProgram = createProgram(gl, vs, fs);
      gl.useProgram(glProgram);

      positionAttributeLocation = gl.getAttribLocation(glProgram, "a_position");
      resolutionUniformLocation = gl.getUniformLocation(glProgram, "u_resolution");
      timeUniformLocation = gl.getUniformLocation(glProgram, "u_time");
      colorUniformLocation = gl.getUniformLocation(glProgram, "u_color");
      blueNoiseUniformLocation = gl.getUniformLocation(glProgram, "u_blueNoise");

      // 删掉 const！直接给全局变量 positionBuffer 赋值
      positionBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([
          -1, -1, 1, -1, -1, 1,
          -1, 1, 1, -1, 1, 1
        ]),
        gl.STATIC_DRAW
      );

      gl.enableVertexAttribArray(positionAttributeLocation);
      gl.vertexAttribPointer(positionAttributeLocation, 2, gl.FLOAT, false, 0, 0);

      blueNoiseTexture = loadTexture(gl, 'assets/blueNoise.png');

      // --- Phase 2: GPU 投影 Shader (带像素级裁剪) ---
      const gridVS = createShader(gl, gl.VERTEX_SHADER, `
        attribute vec3 a_pos3d;
        uniform float u_scrollY;
        uniform float u_fov;
        uniform float u_rotationX;
        uniform vec2 u_resolution;
        varying float v_z; // 传给 FS 的深度

        void main() {
          float cosX = cos(u_rotationX);
          float sinX = sin(u_rotationX);
          
          float translatedY = a_pos3d.y - u_scrollY;
          float rotatedY = 41.0 * translatedY * cosX - 0.1 * a_pos3d.z * sinX;
          float rotatedZ = a_pos3d.z * cosX; 
          
          v_z = rotatedZ; // 记录深度

          // 即使在相机后，我们也给它一个数学上合理的坐标，由 FS 负责剔除
          float safeZ = max(rotatedZ, 1.0); 
          float scale = u_fov / safeZ;
          float x = (a_pos3d.x * scale) / (u_resolution.x / 2.0);
          float y = (rotatedY * scale) / (u_resolution.y / 2.0);
          gl_Position = vec4(x, y, 0.0, 1.0);
        }
      `);
      const gridFS = createShader(gl, gl.FRAGMENT_SHADER, `
        precision mediump float;
        uniform vec4 u_color;
        varying float v_z;
        void main() {
          // 如果深度小于近平面（比如 20.0），直接丢弃该像素
          if (v_z < 20.0) discard; 
          gl_FragColor = u_color;
        }
      `);
      gridProgram = createProgram(gl, gridVS, gridFS);
      // 必须匹配 Shader 里的新名字 a_pos3d
      gridPositionLoc = gl.getAttribLocation(gridProgram, "a_pos3d");
      gridResLoc = gl.getUniformLocation(gridProgram, "u_resolution");
      gridColorLoc = gl.getUniformLocation(gridProgram, "u_color");
      gridBuffer = gl.createBuffer();

      // --- Phase 3: Node Shader (渲染发光点) ---
      const nodeVS = createShader(gl, gl.VERTEX_SHADER, `
        attribute vec3 a_pos3d;
        uniform float u_scrollY;
        uniform float u_fov;
        uniform float u_rotationX;
        uniform vec2 u_resolution;
        varying float v_alpha;

        void main() {
          float cosX = cos(u_rotationX);
          float sinX = sin(u_rotationX);
          float rotatedY = 41.0 * (a_pos3d.y - u_scrollY) * cosX - 0.1 * a_pos3d.z * sinX;
          float rotatedZ = a_pos3d.z * cosX; 

          if (rotatedZ <= 20.0) {
            gl_Position = vec4(-2.0, -2.0, 0.0, 1.0);
          } else {
            float scale = u_fov / rotatedZ;
            gl_Position = vec4((a_pos3d.x * scale) / (u_resolution.x / 2.0), (rotatedY * scale) / (u_resolution.y / 2.0), 0.0, 1.0);
            // 模拟 NODE_SIZE * Math.min(p.scale, 1.0)
            gl_PointSize = 3.5 * min(scale, 1.0); // 稍微放大一点以包含发光边缘
            v_alpha = 1.0 - min(rotatedZ / 8000.0, 1.0);
          }
        }
      `);
      const nodeFS = createShader(gl, gl.FRAGMENT_SHADER, `
        precision mediump float;
        uniform vec3 u_color;
        varying float v_alpha;
        void main() {
          float dist = max(abs(gl_PointCoord.x - 0.5), abs(gl_PointCoord.y - 0.5));
          if (dist > 0.5) discard;
          float glow = 1.0 - dist * 1.0;
          gl_FragColor = vec4(u_color, v_alpha * glow);
        }
      `);
      window.nodeProgram = createProgram(gl, nodeVS, nodeFS);
      // 预分配一个足够大的数组：(81*41 + 80*41) * 2个点 * 2个坐标
      gridVertexArray = new Float32Array(20000);
    }

    function renderBackground(time) {
      if (!gl) return;
      time *= 0.001;

      // 1. 强制重置 WebGL 状态
      gl.useProgram(glProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.enableVertexAttribArray(positionAttributeLocation);
      gl.vertexAttribPointer(positionAttributeLocation, 2, gl.FLOAT, false, 0, 0);

      // 2. 确保背景是不透明的，关闭混合
      gl.disable(gl.BLEND);

      currentR += (targetR - currentR) * 0.02;
      currentG += (targetG - currentG) * 0.02;
      currentB += (targetB - currentB) * 0.02;

      gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

      // 3. 重新设置背景 Uniforms (非常重要，切换 Program 后必须重设)
      gl.uniform2f(resolutionUniformLocation, gl.canvas.width, gl.canvas.height);
      gl.uniform1f(timeUniformLocation, time);
      gl.uniform3f(colorUniformLocation, currentR / 255, currentG / 255, currentB / 255);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, blueNoiseTexture);
      gl.uniform1i(blueNoiseUniformLocation, 0);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    function masterInit() {
      // 1. 限制最大渲染分辨率，防止缩放时显存爆炸
      const MAX_RES = 2560; 
      const dpr = Math.min(window.devicePixelRatio, 2);
      
      // 逻辑尺寸用于数学计算
      const logicalWidth = window.innerWidth;
      const logicalHeight = window.innerHeight;
      
      // 物理尺寸用于画布缓冲区
      let renderWidth = logicalWidth * dpr;
      let renderHeight = logicalHeight * dpr;

      // 如果物理尺寸超过上限，进行等比缩放
      if (renderWidth > MAX_RES) {
        const ratio = MAX_RES / renderWidth;
        renderWidth = MAX_RES;
        renderHeight *= ratio;
      }

      width = renderWidth;
      height = renderHeight;

      fgCanvas.width = width;
      fgCanvas.height = height;
      if (gl) {
        bgCanvas.width = width;
        bgCanvas.height = height;
      }

      stars.length = 0;
      for (let i = 0; i < STAR_COUNT; i++) {
        stars.push({
          x: (0.15 + 0.7 * Math.random()) * width,
          y: (Math.random() - 0.9) * height,
          depth: Math.random() * 0.4 + 0.1,
          size: Math.random() * 1.2 + 0.5
        });
      }

      gridPoints.length = 0;
      let lineData = [];
      let nodeData = []; // 新增：存放点的 3D 坐标

      const START_J = 1; // 固化起始排

      for (let i = -GRID_DIMENSIONS; i <= GRID_DIMENSIONS; i++) {
        for (let j = START_J; j <= GRID_DEPTH_SEGMENTS; j++) {
          const px = i * GRID_SPACING;
          const py = 0;
          const pz = j * 1.5 * GRID_SPACING;

          gridPoints.push({ x: px, y: py, z: pz });
          nodeData.push(px, py, pz); // 收集点数据

          if (j > START_J) {
            lineData.push(px, py, pz, px, py, (j - 1) * 1.5 * GRID_SPACING);
          }
          if (i > -GRID_DIMENSIONS) {
            lineData.push(px, py, pz, (i - 1) * GRID_SPACING, py, pz);
          }
        }
      }

      // 更新线段 Buffer
      gl.bindBuffer(gl.ARRAY_BUFFER, gridBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lineData), gl.STATIC_DRAW);
      gridPointsCount = lineData.length / 3;

      // 更新点 Buffer (Phase 3)
      if (!window.nodeBuffer) window.nodeBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, window.nodeBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(nodeData), gl.STATIC_DRAW);
      window.nodeCount = nodeData.length / 3;
    }

    function masterAnimate(time) {
      scrollY = window.scrollY;
      const scrollHeight = document.body.scrollHeight - window.innerHeight;
      const scrollRatio = scrollHeight > 0 ? scrollY / scrollHeight : 0;

      const targetY = 1200 * (0 + 0.01 * (1 - scrollRatio));
      const targetRotationX = (0.5 * (-6 + 6 * scrollRatio)) * Math.PI / 180 + 1.45;

      // --- DIRTY FLAG CHECK ---
      const deltaY = Math.abs(camera.y - targetY);
      const deltaRot = Math.abs(camera.rotationX - targetRotationX);

      // 如果变化极小，且不是第一帧，直接跳过渲染
      if (deltaY < 0.01 && deltaRot < 0.001 && time > 1000) {
        requestAnimationFrame(masterAnimate);
        return;
      }
      // -------------------------

      camera.y += (targetY - camera.y) * camera.lerpFactor;
      camera.rotationX += (targetRotationX - camera.rotationX) * camera.lerpFactor;


      if (gl) renderBackground(time);
      drawForeground();

      requestAnimationFrame(masterAnimate);
    }

    const sections = document.querySelectorAll('section[data-color]');
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const [r, g, b] = entry.target.dataset.color.split(',').map(Number);
          targetR = r;
          targetG = g;
          targetB = b;
        }
      });
    }, { threshold: 0.5 });

    sections.forEach(section => observer.observe(section));

    const lightbox = document.getElementById('lightbox');
    const lightboxContent = lightbox.querySelector('.lightbox-content');

    function openLightbox(sourceElement) {
      lightboxContent.innerHTML = '';
      const clone = sourceElement.cloneNode(true);
      if (clone.tagName === 'VIDEO') {
        clone.setAttribute('controls', '');
        clone.removeAttribute('autoplay');
      }
      lightboxContent.appendChild(clone);
      lightbox.style.display = 'flex';
    }

    lightbox.addEventListener('click', () => {
      lightbox.style.display = 'none';
      lightboxContent.innerHTML = '';
    });

    document.querySelectorAll('.cs-card').forEach(card => {
      card.addEventListener('click', function (e) {
        // 链接不触发卡片逻辑
        if (e.target.tagName === 'A' || e.target.closest('a')) return;

        const isExpanded = card.classList.contains('is-expanded');
        const visualArea = e.target.closest('.cs-visual');

        if (!isExpanded) {
          // 只要没展开，点卡片任何地方（包括图片）都只执行展开
          card.classList.add('is-expanded');
        } else {
          // 只有在已经展开的情况下，点击图片区域才触发 Lightbox
          if (visualArea && (e.target.tagName === 'IMG' || e.target.tagName === 'VIDEO')) {
            openLightbox(e.target);
          } else if (e.target.closest('.trigger-close')) {
            // 只有点关闭按钮才收起
            card.classList.remove('is-expanded');
            card.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
      });
    });


    // 同时也给 Tech Gallery 增加预览功能
    document.querySelectorAll('.tg-visual').forEach(tgv => {
      tgv.style.cursor = 'zoom-in';
      tgv.addEventListener('click', (e) => {
        const media = tgv.querySelector('img, video');
        if (media) openLightbox(media);
      });
    });


    let resizeTimeout;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        masterInit();
        if (gl) gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
      }, 150); // 延迟 150ms 执行，避开缩放时的压力峰值
    });

    setupWebGL();
    masterInit();
    requestAnimationFrame(masterAnimate);