// Diorama — the webcam and the face tracker.
//
// The picture never leaves the page: the stream goes into a <video> element, each frame of it is handed to
// MediaPipe's Face Landmarker running in this tab (WebAssembly, with the GPU where there is one), and what
// comes out is 478 points on the face. Only two numbers' worth of that are kept: where the eyes are and how
// big the irises look. Nothing is recorded, stored or sent anywhere.
//
// The model and its runtime are fetched only when the camera is switched on, so the mouse mode costs nothing.

import { HeadMeter, BodyMeter, focalFromFov } from './headpose.js';

const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

/**
 * While the face tracker has the viewer, the pose model runs only on every Nth camera frame: often enough to
 * keep learning the viewer's shoulders, seldom enough to cost little. When the face is lost it runs on every frame.
 */
const POSE_EVERY = 6;

/**
 * A laptop or desktop webcam's horizontal field of view, in degrees, before calibration. They run from about
 * 55 (older laptop cameras) to 80 (wide desk cameras); the Calibrate action replaces the guess with a
 * measurement, so this only has to be near enough for the first look.
 */
export const DEFAULT_CAMERA_FOV = 62;

let landmarkerPromise = null;
let posePromise = null;

/** The pose landmarker (the backup), loaded once for the page. Rejects if it cannot be fetched. */
function loadPose() {
  posePromise ??= (async () => {
    const { PoseLandmarker, FilesetResolver } = await import(`${VISION}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
    const make = (delegate) => PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: POSE_MODEL, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
    });
    try { return await make('GPU'); } catch { return make('CPU'); }
  })();
  posePromise.catch(() => { posePromise = null; });
  return posePromise;
}

/** The face landmarker, loaded once for the page. Rejects if the runtime or the model cannot be fetched. */
function loadLandmarker() {
  landmarkerPromise ??= (async () => {
    const { FaceLandmarker, FilesetResolver } = await import(`${VISION}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
    const make = (delegate) => FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
    });
    try { return await make('GPU'); } catch (err) {
      console.warn('Diorama: the face tracker could not use the GPU, falling back to the CPU', err);
      return make('CPU');
    }
  })();
  landmarkerPromise.catch(() => { landmarkerPromise = null; }); // let a later attempt try again
  return landmarkerPromise;
}

export class Tracker {
  /**
   * @param video the <video> element the camera plays in (it doubles as the preview)
   * @param onSample called for every camera frame: ({ head, source, landmarks, pose, time }) with `head` the
   *   point between the eyes in the camera frame in metres, or null when the viewer was not found; `source` is
   *   'face' (the face tracker), 'body' (the pose backup) or null
   * @param focalScale returns the calibration's correction to the default focal length (1 before calibration)
   */
  constructor(video, onSample, focalScale = () => 1) {
    this.video = video;
    this.onSample = onSample;
    this.focalScale = focalScale;
    this.meter = new HeadMeter();
    this.body = new BodyMeter();
    this.pose = null;     // the pose landmarker, once it has loaded (the face tracker does not wait for it)
    this.frames = 0;
    this.last = null; // the latest face's landmarks, kept for calibration
    this.state = 'off'; // 'off' | 'starting' | 'on'
    this.stream = null;
    this.landmarker = null;
    this.generation = 0; // start/stop pairs: a start that finishes after a stop must not come alive
    this.rate = 0;       // camera frames tracked per second, smoothed
    this.lastTime = null;
    this.lastVideoTime = -1;
  }

  /**
   * Switches the camera on. `stream` lets a test hand in its own MediaStream instead of the webcam.
   * Rejects with the browser's own error if permission is refused or there is no camera.
   */
  async start(stream = null) {
    if (this.state !== 'off') return;
    const gen = ++this.generation;
    this.state = 'starting';
    try {
      if (!stream) {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('this browser cannot open a camera here (it needs https or localhost)');
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
        });
      }
      if (gen !== this.generation) { stream.getTracks().forEach((t) => t.stop()); return; }
      this.stream = stream;
      this.video.srcObject = stream;
      await this.video.play();
      const landmarker = await loadLandmarker();
      if (gen !== this.generation) return;
      this.landmarker = landmarker;
      this.state = 'on';
      this.lastTime = null;
      this.meter.reset();
      this.body.reset();
      this.schedule(gen);
      // The backup loads behind the face tracker and joins in when it arrives; without it there is simply no backup.
      loadPose().then((p) => { if (gen === this.generation) this.pose = p; })
        .catch((err) => console.warn('Diorama: the pose backup is unavailable; tracking needs the face', err));
    } catch (err) {
      if (gen === this.generation) this.stop();
      throw err;
    }
  }

  stop() {
    this.generation++;
    this.state = 'off';
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.pose = null;
    this.video.srcObject = null;
    this.rate = 0;
  }

  /** Runs `tick` once per camera frame (not per screen frame: tracking the same picture twice gains nothing). */
  schedule(gen) {
    const again = () => { if (gen === this.generation && this.state === 'on') { this.tick(); this.schedule(gen); } };
    if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(again);
    else requestAnimationFrame(again);
  }

  /** The camera's focal length in pixels: the default field of view, corrected by the calibration (or by `scale`). */
  focal(scale = this.focalScale()) {
    return focalFromFov(this.video.videoWidth, DEFAULT_CAMERA_FOV) * scale;
  }

  /** The latest face measured again at another focal scale, without teaching the meter anything. */
  remeasure(scale) {
    const l = this.last;
    return l ? this.meter.measure(l.landmarks, l.width, l.height, this.focal(scale), { learn: false }) : null;
  }

  tick() {
    const v = this.video;
    if (!(v.videoWidth > 0) || v.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = v.currentTime;
    const now = performance.now();
    let landmarks = null;
    try {
      landmarks = this.landmarker.detectForVideo(v, now).faceLandmarks?.[0] ?? null;
    } catch (err) {
      console.warn('Diorama: the face tracker failed on a frame', err);
    }
    if (this.lastTime !== null) {
      const dt = (now - this.lastTime) / 1000;
      if (dt > 0) this.rate += (1 / dt - this.rate) * 0.1;
    }
    this.lastTime = now;
    const w = v.videoWidth, h = v.videoHeight, f = this.focal();
    let head = landmarks ? this.meter.measure(landmarks, w, h, f) : null;
    this.last = head ? { landmarks, width: w, height: h } : null;
    let source = head ? 'face' : null, pose = null;
    if (this.pose && (!head || this.frames++ % POSE_EVERY === 0)) {
      try {
        pose = this.pose.detectForVideo(v, now).landmarks?.[0] ?? null;
      } catch (err) {
        console.warn('Diorama: the pose backup failed on a frame', err);
      }
      if (pose && head) this.body.learn(pose, w, h, f, head);
      else if (pose) { head = this.body.measure(pose, w, h, f); if (head) source = 'body'; }
    }
    this.onSample({ head, source, landmarks, pose, time: now / 1000 });
  }
}
