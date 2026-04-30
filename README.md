# rebroadcast

Livestreaming using Sia.  Record your screen using the MediaRecorder API and broadcast it.  This generates a unique stream ID which can be shared.  Every 30 seconds a clip is uploaded and the manifest of clips is updated to all viewing clients.  The manifests contains object share URLs containing each clip and their timestamps.  We use the Media Source Extensions to make this look a seemless video player to the user.  Manifests are encrypted (the decryption key is embedded in the stream ID that users share) so that the operator of the service can not look at users streams.  This is novel because traditional decentralized livestreaming solutions involve WebRTC which many users cannot use as they are behind NAT or they have insufficient bandwidth to broadcast to multiple clients.  This way the streamer can upload to high bandwidth hosts and the viewers can download from them without an intermediary.

## Demo
https://drive.google.com/file/d/1oWXSJXcGI_9KiElZHKd5NEN8plQ3oros/view?usp=sharing

## Run

```bash
bun install
bun dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.
