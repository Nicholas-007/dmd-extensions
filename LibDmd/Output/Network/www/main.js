﻿var url = 'ws://' + window.location.host + '/dmd';
var defaultColor = 0xec843d;
var controller = {

	// dimensions
	_width: 128,
	_height: 32,
	_ar: null,
	_screen: null,

	// coloring stuff
	_color: null,
	_hsl: null,
	_gray2Palette: null,
	_gray4Palette: null,

	// timing stuff
	_bufferTime: 0,
	_started: 0,

	// scene
	_camera: null,
	_scene: null,
	_renderer: null,
	_dmdMesh: null,
	_dotsComposer: null,
	_glowComposer: null,
	_blendComposer: null,
	_dotMatrixPass: null,
	_hblurPass: null,
	_vblurPass: null,
	_blendPass: null,
	_renderTargetDots: null,
	_renderTargetGlow: null,

	// shader parameters
	_renderTargetParameters: {
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		format: THREE.RGBFormat,
		stencilBufer: false
	},
	_dotMatrixParams: {
		size: 2,
		blur: 1.1
	},
	_glowParams: {
		amount: 1.6,
		blur: 1.1
	},

	init: function() {

		var that = this;

		if (!this._color) {
			this.setColor(defaultColor);
		}
		
		this._ar = this._width / this._height;
		this._screen = this.getDimensions();

		this._camera = new THREE.PerspectiveCamera(55, this._ar, 20, 3000);
		this._camera.position.x = 5 * (this._ar - 2);
		this._camera.position.y = 5 * (this._ar - 2);
		this._camera.position.z = 615;

		this._scene = new THREE.Scene();

		// texture
		var blankFrame = new Uint8Array(this._width * this._height * 3);
		var dmdTexture = new THREE.DataTexture(blankFrame, this._width, this._height, THREE.RGBFormat);
		dmdTexture.minFilter = THREE.LinearFilter;
		dmdTexture.magFilter = THREE.LinearFilter;
		var dmdMaterial = new THREE.MeshBasicMaterial({ map: dmdTexture });

		// plane
		var planeGeometry = new THREE.PlaneGeometry(this._width, this._height, 1, 1);
		this._dmdMesh = new THREE.Mesh(planeGeometry, dmdMaterial);
		this._scene.add(this._dmdMesh);
		this._dmdMesh.z = 0;
		this._dmdMesh.scale.x = this._dmdMesh.scale.y = 30 - 0.3125 * this._height; // 128: 20, 192: 10

		// renderer
		this._renderer = new THREE.WebGLRenderer();
		if (document.getElementsByTagName('canvas').length > 0) {
			document.getElementsByTagName('canvas')[0].remove();
		}
		document.body.appendChild(this._renderer.domElement);

		// POST PROCESSING
		// ---------------

		// Init dotsComposer to render the dots effect
		// A composer is a stack of shader passes combined.
		// A render target is an offscreen buffer to save a composer output
		this._renderTargetDots = new THREE.WebGLRenderTarget(this._screen.width, this._screen.height, this._renderTargetParameters);

		// dots Composer renders the dot effect
		this._dotsComposer = new THREE.EffectComposer(this._renderer, this._renderTargetDots);

		var renderPass = new THREE.RenderPass(this._scene, this._camera);

		// a shader pass applies a shader effect to a texture (usually the previous shader output)
		this._dotMatrixPass = new THREE.ShaderPass(THREE.DotMatrixShader);
		this._dotsComposer.addPass(renderPass);
		this._dotsComposer.addPass(this._dotMatrixPass);

		// Init glowComposer renders a blurred version of the scene
		this._renderTargetGlow = new THREE.WebGLRenderTarget(this._screen.width, this._screen.height, this._renderTargetParameters);
		this._glowComposer = new THREE.EffectComposer(this._renderer, this._renderTargetGlow);

		// create shader passes
		this._hblurPass = new THREE.ShaderPass(THREE.HorizontalBlurShader);
		this._vblurPass = new THREE.ShaderPass(THREE.VerticalBlurShader);

		this._glowComposer.addPass(renderPass);
		this._glowComposer.addPass(this._dotMatrixPass);
		this._glowComposer.addPass(this._hblurPass);
		this._glowComposer.addPass(this._vblurPass);

		// blend Composer runs the AdditiveBlendShader to combine the output of dotsComposer and glowComposer
		this._blendPass = new THREE.ShaderPass(THREE.AdditiveBlendShader);
		this._blendPass.uniforms['tBase'].value = this._dotsComposer.renderTarget1;
		this._blendPass.uniforms['tAdd'].value = this._glowComposer.renderTarget1;

		this._blendComposer = new THREE.EffectComposer(this._renderer);
		this._blendComposer.addPass(this._blendPass);
		this._blendPass.renderToScreen = true;

		window.addEventListener('resize', this.onResize.bind(this), false);
		this.onParamsChange();
		this.onResize();
		this._dotMatrixPass.uniforms['resolution'].value = new THREE.Vector2(this._screen.width, this._screen.height);
		this._dotMatrixPass.uniforms['dimension'].value = new THREE.Vector2(this._width, this._height);
		console.log('dim =', this._dotMatrixPass.uniforms['dimension'].value);

		// setup network
		this.websocket = new ReconnectingWebSocket(url, null, { binaryType: 'arraybuffer' });
		this.websocket.onopen = function (e) {
			var init = new ArrayBuffer(1);
			init[0] = 0x0;
			that.send(init);
		};

		this.websocket.onmessage = function (e) {

			var i, colors, numColors, numPlanes, frame;
			var dataView = new DataView(e.data);
			var tag = dataView.getUint8(0);
			var timestamp = dataView.getUint32(1, true);

			switch (tag) {

				// Dimensions
				case 0x01:
					var width = dataView.getUint16(5, true);
					var height = dataView.getUint16(7, true);
					that.setDimensions({ width: width, height: height });
					break;

				// Color
				case 0x02: 
					that.setColor(dataView.getUint32(5, true));
					break;

				// Palette
				case 0x03:
					numColors = dataView.getUint16(5, true);
					colors = [];
					for (i = 0; i < numColors; i++) {
						colors.push(dataView.getInt32(7 + i * 4, true));
					}
					that.setPalette(colors);
					break;

				// GrayFrame
				case 0x10: 
					numPlanes = dataView.getUint8(5);
					frame = new DataView(e.data, 6);
					that.renderFrame(timestamp, numPlanes, frame);
					break;

				// ColoredGrayFrame
				case 0x11: 
					numPlanes = dataView.getUint8(5);
					numColors = Math.pow(2, numPlanes);
					colors = [];
					for (i = 0; i < numColors; i++) {
						colors.push(dataView.getInt32(6 + i * 4, true));
					}
					frame = new DataView(e.data, 6 + numColors * 4);
					that.renderFrame(timestamp, numPlanes, frame, colors);
					break;

				// Rgb24Frame
				case 0x12: 
					that.renderRgb24(timestamp, new DataView(e.data, 5));
					break;

				// ClearDisplay
				case 0x20: 
					break;

				// ClearColor
				case 0x21: 
					that.clearColor();
					break;

				// ClearPalette
				case 0x22:
					that.clearPalette();
					break;
			}
		};

		this.websocket.onerror = function(e) {
			console.error(e);
		};

		this.websocket.onclose = function (e) {
			that.clear();
			console.log('Connection closed');
		};
	},

	renderRgb24(timestamp, frame) {
		// TODO implement
		console.log('Colored rgb24 Frame: %s', timestamp);
	},

	renderFrame: function(timestamp, numPlanes, planes, colors) {

		if (!this._clientStart) {
			this._clientStart = Date.now();
			this._serverStart = timestamp;
		}
		var serverDiff = timestamp - this._serverStart;
		var clientDiff = new Date().getTime() - this._clientStart;
		var delay = this._bufferTime + serverDiff - clientDiff;

		if (delay < 0) {
			this._bufferTime -= delay;
			console.log("Increasing buffer time to %sms.", this._bufferTime);
			delay = 0;
		}

		var that = this;
		var frame = this.grayToRgb24(that.joinPlanes(numPlanes, planes), colors || Math.pow(2, numPlanes));
		setTimeout(function () {
			that._dmdMesh.material.map.image.data = frame;
			that._dmdMesh.material.map.needsUpdate = true;
			that.renderCanvas();
		}, delay);
	},

	setDimensions: function (dim) {
		var dimensionsChanged = false;
		if (this._width !== dim.width || this._height !== dim.height) {
			dimensionsChanged = true;
		}
		this._width = dim.width;
		this._height = dim.height;
		if (dimensionsChanged) {
			console.log('New dimensions: %sx%s', this._width, this._height);
			this.init();
		}
	},

	setColor: function (color) {
		this._color = new THREE.Color(color);
		this._hsl = this._color.getHSL();
		console.log('New color:', color.toString(16));
	},

	setPalette: function (palette) {
		if (palette.length === 4) {
			console.log('Setting palette to %s colors.', palette.length);
			this._gray2Palette = palette;
		}
		if (palette.length === 16) {
			console.log('Setting palette to %s colors.', palette.length);
			this._gray4Palette = palette;
		}
	},

	clear: function () {
		var frame = new Uint8Array(this._width * this._height * 3);
		this._dmdMesh.material.map.image.data = frame;
		this._dmdMesh.material.map.needsUpdate = true;
		this.renderCanvas();
	},

	clearColor: function () {
		this._color = defaultColor;
		console.log('Color cleared.');
	},

	clearPalette: function () {
		this._palette = null;
		console.log('Palette cleard.');
	},

	send: function (message) {
		this.websocket.send(message);
	},

	renderCanvas: function () {
		this._dotsComposer.render();
		this._glowComposer.render();
		this._blendComposer.render();
		//this._renderer.render(this._scene, this._camera);
	},

	onParamsChange: function () {

		// copy gui params into shader uniforms
		this._dotMatrixPass.uniforms['size'].value = Math.pow(this._dotMatrixParams.size, 2);
		this._dotMatrixPass.uniforms['blur'].value = Math.pow(this._dotMatrixParams.blur * 2, 2);

		this._hblurPass.uniforms['h'].value = this._glowParams.blur / this._screen.width * 2;
		this._vblurPass.uniforms['v'].value = this._glowParams.blur / this._screen.height * 2;
		this._blendPass.uniforms['amount'].value = this._glowParams.amount;

		this.renderCanvas();
	},

	onResize: function () {
		var dim = this.getDimensions();

		this._renderTargetDots.width = dim.width;
		this._renderTargetDots.height = dim.height;
		this._renderTargetGlow.width = dim.width;
		this._renderTargetGlow.height = dim.height;

		this._renderer.setSize(dim.width, dim.height);
		this._camera.updateProjectionMatrix();
		this.renderCanvas();
	},

	getDimensions: function() {
		var windowAR = window.innerWidth / window.innerHeight;
		var width, height;
		if (windowAR > this._ar) {
			height = window.innerHeight;
			width = window.innerHeight * this._ar;
		} else {
			width = window.innerWidth;
			height = window.innerWidth / this._ar;
		}
		return { width: width, height: height };
	},

	grayToRgb24: function (buffer, paletteOrNumColors) {
		var rgbFrame = new Uint8Array(this._width * this._height * 3);
		var pos = 0;
		var dotColor = new THREE.Color();
		var palette = null;
		if (paletteOrNumColors.constructor === Array) {
			palette = paletteOrNumColors;
		} else {
			if (paletteOrNumColors === 4 && this._gray2Palette) {
				palette = this._gray2Palette;
			}
			if (paletteOrNumColors === 16 && this._gray4Palette) {
				palette = this._gray4Palette;
			}
		}
		for (var y = this._height - 1; y >= 0; y--) {
			for (var x = 0; x < this._width; x++) {
				if (palette) {
					dotColor = new THREE.Color(palette[buffer[y * this._width + x]]);
				} else {
					var lum = buffer[y * this._width + x] / paletteOrNumColors;
					dotColor.setHSL(this._hsl.h, this._hsl.s, lum * this._hsl.l);
				}
				rgbFrame[pos] = Math.floor(dotColor.r * 255);
				rgbFrame[pos + 1] = Math.floor(dotColor.g * 255);
				rgbFrame[pos + 2] = Math.floor(dotColor.b * 255);
				pos += 3;
			}
		}
		return rgbFrame;
	},

	joinPlanes: function(bitLength, planes) {
		var frame = new ArrayBuffer(this._width * this._height);
		var planeSize = planes.byteLength / bitLength;
		for (var bytePos = 0; bytePos < this._width * this._height / 8; bytePos++) {
			for (var bitPos = 7; bitPos >= 0; bitPos--) {
				for (var planePos = 0; planePos < bitLength; planePos++) {
					var bit = this.isBitSet(planes.getInt8(planeSize * planePos + bytePos), bitPos) ? 1 : 0;
					frame[bytePos * 8 + bitPos] |= (bit << planePos);
				}
			}
		}
		return frame;
	},

	isBitSet: function (byte, pos) {
		return (byte & (1 << pos)) !== 0;
	}
}

window.addEventListener("load", controller.init.bind(controller), false);