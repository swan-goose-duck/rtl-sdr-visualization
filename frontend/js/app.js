import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { io } from 'https://cdn.socket.io/4.7.4/socket.io.esm.min.js';

// line chart setup
const lineCtx = document.getElementById('lineChart').getContext('2d');
let lineChart = new Chart(lineCtx, {
    type: 'line',
    data: {
        labels: [],
        datasets: [{
            label: 'Power Spectrum',
            borderColor: 'rgb(0, 255, 255)',
            backgroundColor: 'rgba(0, 255, 255, 0.1)',
            borderWidth: 1,
            pointRadius: 0,
            fill: true,
            data: []
        }]
    },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
            x: {
                title: { display: true, text: 'Frequency (MHz)', color: '#fff' },
                grid: { color: 'rgba(255, 255, 255, 0.1)' },
                ticks: { color: '#fff' }
            },
            y: {
                title: { display: true, text: 'Power (dB)', color: '#fff' },
                grid: { color: 'rgba(255, 255, 255, 0.1)' },
                ticks: { color: '#fff' }
            }
        },
    }
});

function updateLineChart(data) {
    if (!data.freqs || !data.power) return;

    // convert to MHz
    const freqMHz = data.freqs.map(f => f / 1e6);
    
    lineChart.data.labels = freqMHz;
    lineChart.data.datasets[0].data = data.power;
    lineChart.update();
}

class WaterfallVisualizer {
    constructor(container) {
        this.container = container;
        this.scene = new THREE.Scene();
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.lines = [];
        
        this.config = {
            maxLines: 5000,
            lineWidth: 50,
            zScale: 2.0,
            spacing: 1.0,
            colors: [
                [0.0, 0x0000ff],   // blue
                [0.25, 0x00ffff],  // cyan
                [0.5, 0x00ff00],   // green
                [0.75, 0xffff00],  // yellow
                [1.0, 0xff0000]    // red
            ]
        };

        this.initThree();
        this.setupScene();
        this.animate();
    }

    initThree() {
        // container dims
        const width = this.container.clientWidth;
        const height = this.container.clientHeight;

        // set up with container size
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.container.appendChild(this.renderer.domElement);

        // orthographic camera
        this.camera = new THREE.OrthographicCamera(
            0,      // left
            width,  // right
            height, // top
            0,      // bottom
            1,      // near
            1000    // far
        );
        this.camera.position.z = 100;

        // resize observer
        new ResizeObserver(() => this.onResize()).observe(this.container);
    }

    onResize() {
        const width = this.container.clientWidth;
        const height = this.container.clientHeight;

        // update renderer
        this.renderer.setSize(width, height);

        // update camera
        this.camera.right = width;
        this.camera.top = height;
        this.camera.updateProjectionMatrix();
    }

    setupScene() {
        // black background
        this.scene.background = new THREE.Color(0x000000);
        
        // ambient light ... ?
        const ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
        this.scene.add(ambientLight);
    }

    addData(data) {
        const geometry = this.createGeometry(data);
        const material = new THREE.LineBasicMaterial({
            vertexColors: true,
            linewidth: this.config.lineWidth
        });
        
        const line = new THREE.Line(geometry, material);
        
        // put new line at the very top
        line.position.y = this.container.clientHeight;
        
        this.lines.unshift(line);
        this.scene.add(line);

        // remove oldest line if needed
        if (this.lines.length > this.config.maxLines) {
            this.scene.remove(this.lines.pop());
        }

        // move all lines down
        this.lines.forEach(line => {
            line.position.y -= this.config.spacing;
            
            // remove lines that hit bottom
            if (line.position.y < -this.config.spacing) {
                this.scene.remove(line);
                this.lines = this.lines.filter(l => l !== line);
            }
        });
    }

    createGeometry(data) {
        const spectrum = this.normalizeData(data.waterfall);
        const positions = new Float32Array(spectrum.length * 3);
        const colors = new Float32Array(spectrum.length * 3);
        
        // span full window width
        const containerWidth = this.container.clientWidth;
        const xScale = containerWidth / (spectrum.length - 1);

        for (let i = 0; i < spectrum.length; i++) {
            // x position spans full width
            positions[i*3] = i * xScale;
            positions[i*3+1] = 0;
            positions[i*3+2] = spectrum[i] * this.config.zScale;

            const color = this.getColor(spectrum[i]);
            colors[i*3] = color.r;
            colors[i*3+1] = color.g;
            colors[i*3+2] = color.b;
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        
        return geometry;
    }

    normalizeData(data) {
        const min = Math.min(...data);
        const max = Math.max(...data);
        const range = max - min;
        return range === 0 ? data.map(() => 0.5) : data.map(v => ((v - min) / range));
    }

    getColor(value) {
        // more contrast between color stops
        value = Math.min(Math.max(value, 0), 1);
        
        // find surrounding color stops
        for (let i = 1; i < this.config.colors.length; i++) {
            if (value <= this.config.colors[i][0]) {
                const prev = this.config.colors[i-1];
                const next = this.config.colors[i];
                const t = (value - prev[0]) / (next[0] - prev[0]);
                
                // use HSL
                const c1 = new THREE.Color(prev[1]).getHSL({});
                const c2 = new THREE.Color(next[1]).getHSL({});
                
                const hue       = c1.h + t * (c2.h - c1.h);
                const sat       = c1.s + t * (c2.s - c1.s);
                const lightness = c1.l + t * (c2.l - c1.l);
                
                return new THREE.Color().setHSL(hue, sat * 1.5, lightness); // Boost saturation
            }
        }
        return new THREE.Color(this.config.colors.at(-1)[1]);
    }

    animate() {
        requestAnimationFrame(() => this.animate());
        this.renderer.render(this.scene, this.camera);
    }

    addTestData() {
        // generate initial test pattern
        const testData = {
            freqs: Array.from({length: 100}, (_, i) => i),
            waterfall: Array.from({length: 100}, (_, i) => 
                Math.sin(i/10) * 0.5 + 0.5 + Math.random() * 0.1
            )
        };
        
        // create initial set of lines
        for (let i = 0; i < this.config.maxLines; i++) {
            this.addData(testData);
            testData.waterfall = testData.waterfall.map(v => 
                Math.min(1, v + (Math.random() - 0.5) * 0.1)
            );
        }
    }
}

let visualizer;
let socket;
let isStreaming = false;

async function initialize() {
    // initialize visualizer
    visualizer = new WaterfallVisualizer(document.getElementById('waterfall-container'));

    // socketio setup
    socket = io('http://localhost:8000', {
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000
    });

    // socket handlers
    socket.on('connect', () => {
        document.getElementById('status').className = 'status-dot connected';
    });

    socket.on('disconnect', () => {
        document.getElementById('status').className = 'status-dot disconnected';
    });

    socket.on('spectrum_data', (data) => {
        if (!isStreaming) return;

        try {
            // handle both stringified JSON and pre-parsed objects
            const parsedData = typeof data === 'string' ? JSON.parse(data) : data;
            
            // validate data structure
            if (!parsedData.freqs || !parsedData.waterfall) {
                throw new Error('Invalid data structure');
            }

            visualizer.addData(parsedData);
            updateLineChart(parsedData);
        } catch (error) {
            console.error('Data parsing error:', error);
            console.log('Raw received data:', data);
        }
    });

    // button handler
    document.getElementById('startBtn').addEventListener('click', async () => {
        try {
            const params = {
                center_freq: parseFloat(document.getElementById('centerFreq').value) * 1e6,
                sampling_rate: parseFloat(document.getElementById('sampleRate').value) * 1e6,
                gain: 'auto',
                fft_size: parseInt(document.getElementById('fftSize').value)
            };

            const response = await fetch('http://localhost:5000/api/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params)
            });
            
            if (!response.ok) throw new Error('Start failed');
            isStreaming = true;
        } catch (error) {
            console.error('Start error:', error);
            alert('Failed to start acquisition');
        }
    });

    document.getElementById('stopBtn').addEventListener('click', async () => {
        try {
            const response = await fetch('http://localhost:5000//api/stop', { method: 'POST' });
            if (!response.ok) throw new Error('Stop failed');
            isStreaming = false;
        } catch (error) {
            console.error('Stop error:', error);
            alert('Failed to stop acquisition');
        }
    });
}


// start application
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
} else {
    initialize();
}