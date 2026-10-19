# p5managerd prototype

`p5managerd` is an early PS5 ELF agent intended to work with a browser-based web interface. The first protocol spike listens on TCP port `9831` and exposes only:

- `GET /health` or `GET /api/health` — reports that the agent is running.

It does not yet expose console files, accounts, payload sending, or Remote Play. Mutating or sensitive operations need an authenticated API before they are added.

## Build

The PS5 payload SDK is required. From the repository root:

```bash
make -C p5managerclient/p5managerd
```

The generated `p5managerd.elf` can be sent to a running PS5 payload loader like the other payloads. Once running, check `http://<ps5-address>:9831/health` from a browser on the same network. The current prototype exposes an API health response only; it does not serve the web interface yet.

This prototype has not been tested on console hardware.
