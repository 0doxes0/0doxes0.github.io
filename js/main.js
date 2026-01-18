
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
      uniform sampler2D u_cloudTexture;

      void main() {
        vec2 uv = gl_FragCoord.xy / u_resolution.xy;
        vec2 st = uv;
        st.x *= u_resolution.x / u_resolution.y;

        // 正交对冲平移：一层向右上，一层向右下
        vec2 p1 = st * .4 + vec2(u_time * 0.02, u_time * 0.02);
        vec2 p2 = st * .32 + vec2(u_time * 0.02, u_time * -0.04);

        float val1 = texture2D(u_cloudTexture, p1).r;
        float val2 = texture2D(u_cloudTexture, p2).r;

        // 混合并增强对比度
        // 适当放宽 smoothstep 范围 (0.0 -> 0.6)，配合 CPU 生成的平滑纹理，边缘会非常柔和
        float value = val1 * val2;
        float mask = smoothstep(0.0, 0.6, value);
        mask = pow(mask + 0.4, 2.0); // 增强对比度，突出云层细节
        
        vec3 finalColor = u_color * mask * 0.16;

        
        // 蓝噪声抖动
        float dither = (texture2D(u_blueNoise, gl_FragCoord.xy / 128.0).r - 0.5) / 255.0;
        gl_FragColor = vec4(finalColor + dither, 1.0);
      }
`;

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
        const err = gl.getShaderInfoLog(shader);
        console.error("SHADER ERROR:", err);
        alert("SHADER ERROR: " + err); // 强行弹窗，确保你不会错过
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
      
      // 内部工具：带平滑插值的噪声
      const noise = (x, y, res) => {
        const s = size / res;
        const f = (v) => {
          const t = (v % size) / s;
          const i = Math.floor(t);
          const frac = t - i;
          // Smoothstep 插值曲线：3t^2 - 2t^3
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
          // CPU 分形叠加：4层噪声，彻底消除硬边并增加细节
          let v = 0, amp = 0.5, freq = 4;
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
      // 预分配一个足够大的数组
      gridVertexArray = new Float32Array(20000);

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
          vec3 finalColor = bg + (noise - 0.5) * 0.006;
          gl_FragColor = vec4(finalColor, 1.0);
        }
      `);


      window.blitProgram = createProgram(gl, blitVS, blitFS);
    }

    function renderBackground(time) {
      if (!gl) return;
      
      // 【关键修复】：如果蓝噪声纹理还没加载完，直接跳过背景渲染，防止黑屏卡死状态机
      // 我们通过检查纹理是否已绑定过数据来判断
      if (!window.blueNoiseLoaded) {
        // 可以在这里给个默认清理颜色，避免闪烁
        gl.clearColor(0.01, 0.01, 0.02, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        return;
      }

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
      
      // 【关键修复】：必须为 blitProgram 绑定顶点属性，否则它不知道画在哪
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
      // 1. 限制最大渲染分辨率，防止缩放时显存爆炸
      const MAX_RES = 2560; 
      const dpr = Math.min(window.devicePixelRatio, 1);
      
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

        // 创建 0.4x 离屏缓冲区 (FBO)
        const fboWidth = Math.floor(width * 0.4);
        const fboHeight = Math.floor(height * 0.4);

        if (!window.backgroundFBO) {
          window.backgroundFBO = gl.createFramebuffer();
          window.backgroundTexture = gl.createTexture();
        }

        gl.bindTexture(gl.TEXTURE_2D, window.backgroundTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, fboWidth, fboHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); // 关键：线性过滤实现平滑拉伸
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        gl.bindFramebuffer(gl.FRAMEBUFFER, window.backgroundFBO);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, window.backgroundTexture, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        // 强制重置视口到全分辨率。
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
      // const deltaY = Math.abs(camera.y - targetY);
      // const deltaRot = Math.abs(camera.rotationX - targetRotationX);

      // 如果变化极小，且不是第一帧，直接跳过渲染
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

    // 额外处理：确保所有视频在进入视口时尝试播放
    const videoObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const video = entry.target;
          if (video.paused) {
            video.play().catch(() => {});
          }
        }
      });
    }, { threshold: 0.1 });

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

    document.querySelectorAll('.cs-card').forEach(card => {
      card.addEventListener('click', function (e) {
        // 链接不触发卡片逻辑
        if (e.target.tagName === 'A' || e.target.closest('a')) return;

        const isExpanded = card.classList.contains('is-expanded');
        const visualArea = e.target.closest('.cs-visual');

        if (!isExpanded) {
          // 只要没展开，点卡片任何地方（包括图片）都只执行展开
          card.classList.add('is-expanded');
          
          // 解决视频黑屏问题：显式寻找并播放展开区域内的所有视频
          const hiddenVideos = card.querySelectorAll('.cs-details video');
          hiddenVideos.forEach(v => {
            v.play().catch(err => console.warn("Video play interrupted:", err));
          });
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
      }, 150); // 延迟 150ms 执行，避开缩放时的压力峰值
    });

    setupWebGL();
    masterInit();
    requestAnimationFrame(masterAnimate);