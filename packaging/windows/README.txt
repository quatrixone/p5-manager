P5 Manager - portable Windows build
===================================

Start
  Double-click P5Manager.exe. A console window opens (that is the server and
  its log) and your browser opens http://localhost:3001/ once it is ready.
  Close the console window to stop P5 Manager.

  The first start may show a Windows Firewall prompt for node.exe and
  python.exe: allow them on private networks, otherwise the console's log
  streams and Remote Play cannot reach this PC.

Your data
  Everything is kept in the "data" folder next to P5Manager.exe: the
  database, payloads, downloads and conversion work files. To update, extract
  the new version somewhere else and move your "data" folder into it.

Other devices
  Phones and other PCs on your network can open http://<this-pc-ip>:3001/.

Options (environment variables, set before starting)
  PORT              web UI port (default 3001)
  P5M_DATA_DIR      another place for the data folder
  P5M_NO_BROWSER=1  do not open the browser (also: P5Manager.exe --no-browser)

Not available on Windows
  - Creating exFAT images (needs Linux loop devices). Use the Docker version
    for that.
  - SMB "remote sources". Type the network path (\\server\share\folder) in
    the Local file browser instead.
