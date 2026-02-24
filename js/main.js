
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
    const GRID_DIMENSIONS = 15;
    const GRID_DEPTH_SEGMENTS = 16;
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

      // 1. 依然用 2D 画星星 (数量少,开销低)
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
      uniform sampler2D u_cloudTexture;

      void main() {
        // --- Visual Tuning Knobs ---
        float warpStrength = 0.05;    // Fluid distortion intensity
        float cloudScale = 0.35;       // Texture tiling scale
        float brightness = 0.5;       // Global color multiplier
        // ---------------------------

        vec2 st = gl_FragCoord.xy / u_resolution.xy;
        st.x *= u_resolution.x / u_resolution.y;

        // Layer 1: Primary noise and distortion source
        vec2 p1 = st * cloudScale + vec2(u_time * 0.01, u_time * 0.02);
        float val1 = texture2D(u_cloudTexture, p1).r;

        // Layer 2: Distorted by Layer 1 to create fluid-like motion
        vec2 p2 = st * (cloudScale * 0.8) + vec2(u_time * 0.02, u_time * -0.035);
        p2 += (val1 - 0.5) * warpStrength; 
        float val2 = texture2D(u_cloudTexture, p2).r;

        // Combine layers and calculate mask
        float mask = val1 * val2;
        
        // Final color composition without spaceColor offset
        // linear contrast knob
        vec3 finalColor = u_color * (mask + 0.25) * (mask + 0.25) * brightness;

        // Blue noise dithering to prevent color banding
        float dither = (texture2D(u_blueNoise, gl_FragCoord.xy / 128.0).r - 0.5) / 255.0;
        gl_FragColor = vec4(finalColor + dither, 1.0);
      }
`;



    // 必须在全局声明,确保所有函数都能访问到这些"句柄"
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
        const err = gl.getShaderInfoLog(shader);
        console.error("SHADER ERROR:", err);
        alert("SHADER ERROR: " + err); // 强行弹窗,确保你不会错过
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

    function createCloudTexture(gl) {
      const size = 64;
      const data = new Uint8Array(size * size * 4);
      
      // 内部工具:带平滑插值的噪声
      const noise = (x, y, res) => {
        const s = size / res;
        const f = (v) => {
          const t = (v % size) / s;
          const i = Math.floor(t);
          const frac = t - i;
          // Smoothstep 插值曲线:3t^2 - 2t^3
          const sn = frac * frac * (3.0 - 2.0 * frac);
          return { i, sn };
        };
        
        const nx = f(x), ny = f(y);
        const seed = (ix, iy) => {
          const v = Math.sin((ix % res) * 12.9898 + (iy % res) * 78.233) * 43758.5453;
          return v - Math.floor(v);
        };

        const v00 = seed(nx.i, ny.i), v10 = seed(nx.i + 1, ny.i);
        const v01 = seed(nx.i, ny.i + 1), v11 = seed(nx.i + 1, ny.i + 1);
        return v00 * (1.0 - nx.sn) * (1.0 - ny.sn) + v10 * nx.sn * (1.0 - ny.sn) + 
               v01 * (1.0 - nx.sn) * ny.sn + v11 * nx.sn * ny.sn;
      };

      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          // CPU 分形叠加
          let v = 0, amp = 0.5, freq = 5;
          for(let o = 0; o < 2; o++) {
            v += noise(x, y, freq) * amp;
            amp *= 0.5; freq *= 2;
          }
          const val = Math.floor(v * 255);
          const idx = (y * size + x) * 4;
          data[idx] = data[idx+1] = data[idx+2] = val;
          data[idx+3] = 255;
        }
      }

      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return texture;
    }

    function loadTexture(gl, url) {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.onload = () => {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        window.blueNoiseLoaded = true;
      };
      image.src = url;
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

      // 删掉 const!直接给全局变量 positionBuffer 赋值
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

      blueNoiseTexture = loadTexture(gl, 'Assets/blueNoise.png');
      window.cloudTexture = createCloudTexture(gl);

      // --- Phase 2: GPU 投影 Shader (带像素级裁剪) ---
      const gridVS = createShader(gl, gl.VERTEX_SHADER, `
        attribute vec3 a_pos3d;
        uniform float u_scrollY;
        uniform float u_fov;
        uniform float u_rotationX;
        uniform vec2 u_resolution;
        varying float v_z;

        void main() {
          float cosX = cos(u_rotationX);
          float sinX = sin(u_rotationX);
          
          float translatedY = a_pos3d.y - u_scrollY;
          float rotatedY = 41.0 * translatedY * cosX - 0.1 * a_pos3d.z * sinX;
          float rotatedZ = a_pos3d.z * cosX; 
          
          v_z = rotatedZ;

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
            gl_PointSize = 3.5 * min(scale, 1.0);
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

      // --- 合成 Shader (Blit) ---
      const blitVS = createShader(gl, gl.VERTEX_SHADER, `
        attribute vec2 a_position;
        varying vec2 v_texCoord;
        void main() {
          v_texCoord = a_position * 0.5 + 0.5;
          gl_Position = vec4(a_position, 0.0, 1.0);
        }
      `);
      const blitFS = createShader(gl, gl.FRAGMENT_SHADER, `
        precision highp float;
        uniform sampler2D u_background;
        uniform sampler2D u_blueNoise;
        uniform vec2 u_resolution;
        varying vec2 v_texCoord;
        void main() {
          vec3 bg = texture2D(u_background, v_texCoord).rgb;
          vec2 screenCoord = (gl_FragCoord.xy + vec2(0.5)) / 256.0; 
          vec3 noise = texture2D(u_blueNoise, screenCoord).rgb;
          vec3 finalColor = bg + (noise - 0.5) * 0.001;
          gl_FragColor = vec4(finalColor, 1.0);
        }
      `);


      window.blitProgram = createProgram(gl, blitVS, blitFS);
    }

    function renderBackground(time) {
      // Safety check: prevent rendering if program or textures are not ready
      if (!gl || !glProgram || !window.blueNoiseLoaded) return;

      time *= 0.001;
      currentR += (targetR - currentR) * 0.02;
      currentG += (targetG - currentG) * 0.02;
      currentB += (targetB - currentB) * 0.02;

      const fboW = Math.floor(width * 0.4);
      const fboH = Math.floor(height * 0.4);

      // --- Step 1: 渲染背景到 0.4x FBO ---
      gl.bindFramebuffer(gl.FRAMEBUFFER, window.backgroundFBO);
      gl.viewport(0, 0, fboW, fboH);
      
      gl.useProgram(glProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.enableVertexAttribArray(positionAttributeLocation);
      gl.vertexAttribPointer(positionAttributeLocation, 2, gl.FLOAT, false, 0, 0);
      
      gl.uniform2f(resolutionUniformLocation, fboW, fboH);
      gl.uniform1f(timeUniformLocation, time);
      gl.uniform3f(colorUniformLocation, currentR / 255, currentG / 255, currentB / 255);

      // 通道 0: 蓝噪声
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, blueNoiseTexture);
      gl.uniform1i(gl.getUniformLocation(glProgram, "u_blueNoise"), 0);

      // 通道 1: CPU 生成的云纹理
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, window.cloudTexture);
      gl.uniform1i(gl.getUniformLocation(glProgram, "u_cloudTexture"), 1);
      
      gl.drawArrays(gl.TRIANGLES, 0, 6);


      // --- Step 2: Blit 到 1.0x 主画布 ---
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      
      gl.useProgram(window.blitProgram);
      
      // 【关键修复】:必须为 blitProgram 绑定顶点属性,否则它不知道画在哪
      const blitPosLoc = gl.getAttribLocation(window.blitProgram, "a_position");
      gl.enableVertexAttribArray(blitPosLoc);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.vertexAttribPointer(blitPosLoc, 2, gl.FLOAT, false, 0, 0);

      // 传入 0.4x 背景纹理
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, window.backgroundTexture);
      gl.uniform1i(gl.getUniformLocation(window.blitProgram, "u_background"), 0);
      
      // 传入 1.0x 蓝噪声
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, blueNoiseTexture);
      gl.uniform1i(gl.getUniformLocation(window.blitProgram, "u_blueNoise"), 1);
      
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    function masterInit() {
      // 1. 限制最大渲染分辨率,防止缩放时显存爆炸
      const MAX_RES = 2560; 
      const dpr = Math.min(window.devicePixelRatio, 1);
      
      // 逻辑尺寸用于数学计算
      const logicalWidth = window.innerWidth;
      const logicalHeight = window.innerHeight;
      
      // 物理尺寸用于画布缓冲区
      let renderWidth = logicalWidth * dpr;
      let renderHeight = logicalHeight * dpr;

      // 如果物理尺寸超过上限,进行等比缩放
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

        // 创建 0.4x 离屏缓冲区 (FBO)
        const fboWidth = Math.floor(width * 0.4);
        const fboHeight = Math.floor(height * 0.4);

        if (!window.backgroundFBO) {
          window.backgroundFBO = gl.createFramebuffer();
          window.backgroundTexture = gl.createTexture();
        }

        gl.bindTexture(gl.TEXTURE_2D, window.backgroundTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, fboWidth, fboHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); // 关键:线性过滤实现平滑拉伸
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        gl.bindFramebuffer(gl.FRAMEBUFFER, window.backgroundFBO);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, window.backgroundTexture, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        // 强制重置视口到全分辨率.
        gl.viewport(0, 0, width, height);
      }

      // 星星
      stars.length = 0;
      for (let i = 0; i < STAR_COUNT; i++) {
        stars.push({
          x: (0.15 + 0.7 * Math.random()) * width,
          y: (Math.random() * 0.8 - 0.5) * height,
          depth: Math.random() * 0.4 + 0.1,
          size: Math.random() * 1.2 + 0.5
        });
      }

      gridPoints.length = 0;
      let lineData = [];
      let nodeData = []; // 新增:存放点的 3D 坐标

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
      // const deltaY = Math.abs(camera.y - targetY);
      // const deltaRot = Math.abs(camera.rotationX - targetRotationX);

      // 如果变化极小,且不是第一帧,直接跳过渲染
      // if (deltaY < 0.01 && deltaRot < 0.001 && time > 1000) {
      //   requestAnimationFrame(masterAnimate);
      //   return;
      // }
      // -------------------------

      camera.y += (targetY - camera.y) * camera.lerpFactor;
      camera.rotationX += (targetRotationX - camera.rotationX) * camera.lerpFactor;


      if (gl) renderBackground(time);
      drawForeground();

      requestAnimationFrame(masterAnimate);
    }

    const sections = document.querySelectorAll('section[data-color]');
    // 使用 rootMargin 将判定区域压缩至视口中心线
    // threshold: 0 表示只要元素碰到这条线就触发
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const colorData = entry.target.getAttribute('data-color');
          if (colorData) {
            const [r, g, b] = colorData.split(',').map(Number);
            targetR = r;
            targetG = g;
            targetB = b;
          }
        }
      });
    }, { 
      rootMargin: '-50% 0% -50% 0%',
      threshold: 0 
    });

    sections.forEach(section => observer.observe(section));

    /**
     * 优化后的视频可见性观察器
     * 逻辑：只有当视频在视口内，且满足以下条件之一时才播放：
     * 1. 它是 hero 视频（不在 .cs-details 内部）
     * 2. 它所在的 .cs-card 已经展开
     */
    const videoObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        const video = entry.target;
        const detailsPane = video.closest('.cs-details');
        const card = video.closest('.cs-card');
        
        // 判断是否允许播放
        const isHeroVideo = !detailsPane;
        const isExpanded = card && card.classList.contains('is-expanded');

        if (entry.isIntersecting && (isHeroVideo || isExpanded)) {
          video.play().catch(() => {});
        } else {
          // 不在视口或不满足播放条件，立即暂停释放资源
          video.pause();
        }
      });
    }, { threshold: 0.1 });

    // 初始化观察所有视频
    document.querySelectorAll('video').forEach(v => videoObserver.observe(v));

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

    // 核心逻辑：监听属性变化，确保搜索到的内容持久化展开
    const searchObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'hidden') {
          const details = mutation.target;
          // 如果浏览器删除了 hidden 属性（说明搜到了），强制展开父级卡片
          if (!details.hasAttribute('hidden')) {
            const card = details.closest('.cs-card');
            if (card && !card.classList.contains('is-expanded')) {
              card.classList.add('is-expanded');
              card.querySelectorAll('video').forEach(v => v.play().catch(() => {}));
            }
          }
        }
      });
    });    
    
    document.querySelectorAll('.cs-details').forEach(details => {
      const card = details.closest('.cs-card');
      
      // Signal 1: Browser native search match
      details.addEventListener('beforematch', () => {
        card.classList.add('is-expanded');
        card.querySelectorAll('video').forEach(v => v.play().catch(() => {}));
      });

      // Signal 2: Focus fallback (fires when browser jumps to text inside)
      details.addEventListener('focusin', () => {
        if (!card.classList.contains('is-expanded')) {
          card.classList.add('is-expanded');
          details.removeAttribute('hidden');
          card.querySelectorAll('video').forEach(v => v.play().catch(() => {}));
        }
      });
    });

    /**
     * 统一项目展开逻辑
     * 解决点击与 URL Hash 触发时的逻辑复用问题
     */
    function handleProjectExpansion(card) {
      if (!card || card.classList.contains('is-expanded')) return;

      const details = card.querySelector('.cs-details');

      // 1. 排他性处理：收起其他已展开的卡片
      // 必须先执行收起，以确保页面高度变化的第一步被触发
      document.querySelectorAll('.cs-card.is-expanded').forEach(otherCard => {
        otherCard.classList.remove('is-expanded');
        const otherDetails = otherCard.querySelector('.cs-details');
        if (otherDetails) otherDetails.setAttribute('hidden', 'until-found');
        otherCard.querySelectorAll('video').forEach(v => {
          v.pause();
          v.currentTime = 0;
        });
      });

      // 2. 展开当前卡片
      card.classList.add('is-expanded');
      if (details) details.removeAttribute('hidden');

      // 3. 视频处理
      card.querySelectorAll('video').forEach(v => {
        videoObserver.observe(v);
        v.play().catch(() => {});
      });

      // 4. 修正滚动位置
      // 使用双重 requestAnimationFrame 确保在排他性收起和当前展开导致的布局重排完成后再计算坐标
      // 恢复 'instant' 模式以确保在复杂高度变动中 100% 命中顶部
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          card.scrollIntoView({ behavior: 'instant', block: 'start' });
        });
      });
    }

    document.querySelectorAll('.cs-card').forEach(card => {
      card.addEventListener('click', function (e) {
        if (e.target.tagName === 'A' || e.target.closest('a')) return;

        const isExpanded = card.classList.contains('is-expanded');
        const visualArea = e.target.closest('.cs-visual');

        if (!isExpanded) {
          handleProjectExpansion(card);
        } else {
          if (visualArea && (e.target.tagName === 'IMG' || e.target.tagName === 'VIDEO')) {
            openLightbox(e.target);
          } else if (e.target.closest('.trigger-close')) {
            card.classList.remove('is-expanded');
            if (details) details.setAttribute('hidden', 'until-found');
            
            // 收起时立即停止所有视频
            card.querySelectorAll('video').forEach(v => {
              v.pause();
              v.currentTime = 0;
            });
            card.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
      });
    });



    // 统一为所有具有预览性质的容器增加点击监听
    document.querySelectorAll('.tg-visual, .cs-feature-v-media').forEach(container => {
      container.style.cursor = 'zoom-in';
      container.addEventListener('click', (e) => {
        const media = container.querySelector('img, video');
        if (media) openLightbox(media);
      });
    });


    let resizeTimeout;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        masterInit();
        if (gl) gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
      }, 150); // 延迟 150ms 执行,避开缩放时的压力峰值
    });

    setupWebGL();
    masterInit();
    requestAnimationFrame(masterAnimate);

    /**
     * 路由监听：处理外部链接进入或 Hash 变化
     */
    function checkHashAndExpand() {
      const hash = window.location.hash.replace('#', '');
      if (hash) {
        const targetCard = document.getElementById(hash);
        if (targetCard && targetCard.classList.contains('cs-card')) {
          handleProjectExpansion(targetCard);
        }
      }
    }

    window.addEventListener('hashchange', checkHashAndExpand);
    window.addEventListener('load', () => {
      // 延迟执行以避开浏览器原生的、不带展开逻辑的锚点跳转
      setTimeout(checkHashAndExpand, 200);
    });
