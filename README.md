# rebroadcast

Livestreaming from a web browser with video hosted by Sia.  Allows you to record your screen using the MediaRecorder API and broadcast it.  This generates a unique stream ID which can be shared.  Every 30 seconds a clip is uploaded and the viewers continually request a manifest with the list of clips.  The manifests contain shared object URLs and the timestamps for each clip.  We use the Media Source Extensions to make this look a seamless video player to the user.  Manifests are encrypted (the decryption key is embedded in the stream ID that users share) so that the operator of the service can not look at users streams.  This is novel because traditional decentralized livestreaming solutions involve WebRTC which many users cannot use as they are behind NAT or they have insufficient bandwidth to broadcast to multiple clients.  This way the streamer can upload to Sia hosts (who typically have high bandwidth) and the viewers can download from them without an intermediary.

## Demo
https://drive.google.com/file/d/1oWXSJXcGI_9KiElZHKd5NEN8plQ3oros/view?usp=sharing

## Run

```bash
bun install
bun dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.
