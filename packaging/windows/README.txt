P5 Manager - portable Windows build
===================================

Start
  Double-click P5Manager.exe. A console window opens (that is the server and
  its log) and says "P5 Manager is starting". On the first start it unpacks
  its files from P5Manager.pak (the file disappears afterwards), which takes
  a moment; later starts take a few seconds.
  Your browser opens http://localhost:3001/ by itself once it is ready.
  Close the console window to stop P5 Manager.

  The first start may show a Windows Firewall prompt for node.exe and
  python.exe: allow them on private networks, otherwise the console's log
  streams and Remote Play cannot reach this PC.

Your data
  Everything is kept in the "data" folder next to P5Manager.exe: the
  database, payloads, downloads and conversion work files. To update, extract
  the new version somewhere else and move your "data" folder into it.

When something does not work
  Open Logs in the app and press "Log file": it saves the app's log, with
  what this window showed, as one text file you can send along. The files
  themselves are in data\app\logs; they are kept small by themselves (a
  few megabytes at most, older lines make room for new ones).

Other devices
  Phones and other PCs on your network can open http://<this-pc-ip>:3001/.

Options (environment variables, set before starting)
  PORT              web UI port (default 3001)
  P5M_DATA_DIR      another place for the data folder
  P5M_NO_BROWSER=1  do not open the browser (also: P5Manager.exe --no-browser)

Not available on Windows
  - SMB "remote sources". Type the network path (\\server\share\folder) in
    the Local file browser instead.
