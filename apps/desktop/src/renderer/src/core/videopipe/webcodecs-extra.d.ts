// MediaStreamTrackProcessor is shipped in Chromium/Electron but not yet in this TS lib.dom.
// Minimal declaration covering the one shape we use (readable stream of VideoFrames).

interface MediaStreamTrackProcessorInit {
  track: MediaStreamTrack;
  maxBufferSize?: number;
}

declare class MediaStreamTrackProcessor<T = VideoFrame> {
  constructor(init: MediaStreamTrackProcessorInit);
  readonly readable: ReadableStream<T>;
}
