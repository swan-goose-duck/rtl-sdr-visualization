from flask import Flask, request, jsonify
from flask_cors import CORS
from flask_socketio import SocketIO
import numpy as np
import threading
import time
import rtlsdr
import scipy.signal as signal

app = Flask(__name__)
CORS(app)

# ports
API_PORT = 8000
SOCKET_PORT = 5000

socketio = SocketIO(app, cors_allowed_origins="*")

# configuration
sdr = None
sampling_rate = 2.4e6
center_freq = 1090e6
gain = 'auto'
fft_size = 1024
running = False
thread = None
max_render_points = 8192  # max points to send to frontend
bandwidth_factor = 0.2

def setup_sdr():
    global sdr
    try:
        sdr = rtlsdr.RtlSdr()
        sdr.sample_rate = sampling_rate
        sdr.center_freq = center_freq
        sdr.gain = gain
        sdr.set_bandwidth(sampling_rate * bandwidth_factor)
        return True
    except Exception as e:
        print(f"Error initializing RTL-SDR: {e}")
        return False

def downsample_data(data, target_size):
    if len(data) <= target_size:
        return data
    
    # calculate interval to pick from
    interval = max(1, len(data) // target_size)
    return data[::interval]

def process_samples():
    global running
    while running:
        try:
            samples = sdr.read_samples(fft_size * 2)
            fft_result = np.fft.fftshift(np.fft.fft(samples, fft_size))
            power_spectrum = 10 * np.log10(np.abs(fft_result)) # in dB
            freqs = np.fft.fftshift(np.fft.fftfreq(fft_size, 1/sampling_rate)) + center_freq # shift to center frequency (inverse)
            waterfall_data = np.abs(fft_result) ** 2

            # smoothing
            smoothing_window = 9
            if len(power_spectrum) > smoothing_window:
                power_spectrum = signal.savgol_filter(power_spectrum, smoothing_window, 2)

            # downsample - scipy.decimate ...
            if fft_size > max_render_points:
                freqs = downsample_data(freqs, max_render_points)
                power_spectrum = downsample_data(power_spectrum, max_render_points)
                waterfall_data = downsample_data(waterfall_data, max_render_points)

            data = {
                'freqs': freqs.tolist(),
                'power': power_spectrum.tolist(),
                'waterfall': waterfall_data.tolist(),
                'center_freq': center_freq,
                'sampling_rate': sampling_rate
            }

            socketio.emit('spectrum_data', data)
            time.sleep(0.1) # do not overload

        except Exception as e:
            print(f"Error in processing samples: {e}")
            socketio.emit('error', {'message': str(e)})
            running = False

def start_streaming():
    global running, thread
    if not running:
        if setup_sdr():
            running = True
            thread = threading.Thread(target=process_samples)
            thread.daemon = True
            thread.start()
            return True
    return False

def stop_streaming():
    global running, sdr
    running = False
    if thread:
        thread.join(timeout=1.0)
    if sdr:
        sdr.close()
        sdr = None
    return True

@app.route('/api/start', methods=['POST'])
def api_start():
    params = request.get_json()
    global center_freq, sampling_rate, gain, fft_size
    
    if params:
        center_freq = float(params.get('center_freq', center_freq))
        sampling_rate = float(params.get('sampling_rate', sampling_rate))
        gain = params.get('gain', gain)
        fft_size = int(params.get('fft_size', fft_size))
    
    result = start_streaming()
    return jsonify({'success': result})

@app.route('/api/stop', methods=['POST'])
def api_stop():
    result = stop_streaming()
    return jsonify({'success': result})

@app.route('/api/status', methods=['GET'])
def api_status():
    return jsonify({
        'running': running,
        'center_freq': center_freq,
        'sampling_rate': sampling_rate,
        'gain': gain,
        'fft_size': fft_size
    })

@app.route('/api/devices', methods=['GET'])
def api_devices():
    try:
        return jsonify({'devices': rtlsdr.librtlsdr.rtlsdr_get_device_count()})
    except Exception as e:
        return jsonify({'error': str(e)})

@socketio.on('connect')
def handle_connect():
    print('Client connected')

@socketio.on('disconnect')
def handle_disconnect():
    print('Client disconnected')
    if not socketio.server.eio.sockets:
        stop_streaming()

def run_flask():
    print(f"Starting Flask API on port {API_PORT}")
    app.run(host='0.0.0.0', port=API_PORT, debug=False, use_reloader=False)

def run_socketio():
    print(f"Starting WebSocket server on port {SOCKET_PORT}")
    socketio.run(app, host='0.0.0.0', port=SOCKET_PORT, debug=False)

if __name__ == '__main__':
    flask_thread = threading.Thread(target=run_flask)
    socketio_thread = threading.Thread(target=run_socketio)

    flask_thread.start()
    socketio_thread.start()

    flask_thread.join()
    socketio_thread.join()
