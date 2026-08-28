@echo off
REM Serve the Alloy Rebalancer on THIS MACHINE ONLY.
REM Binds to 127.0.0.1 deliberately: this page signs transactions that move real funds across
REM several chains, and serving it over plain HTTP to the LAN would let anyone on the network
REM alter the page in transit. For another device use an SSH tunnel or real HTTPS.
cd /d "%~dp0"
echo.
echo   http://localhost:8900/
echo.
echo   Local only. Press Ctrl+C to stop.
echo.
python -m http.server 8900 --bind 127.0.0.1
