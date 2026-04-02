import subprocess
import time
import socket
import os
from pathlib import Path
import aria2p

class Aria2Manager:
    """Manages the aria2c RPC daemon lifecycle."""
    
    def __init__(self, binary_path, port=6800, secret=None):
        self.binary_path = binary_path
        self.port        = port
        self.secret      = secret
        self.process     = None
        self.api         = None

    def start_daemon(self):
        """Launches aria2c with RPC enabled."""
        if self.is_running():
            print(f"[*] aria2c already running on port {self.port}. Connecting...")
        else:
            print(f"[*] Starting aria2c daemon on port {self.port}...")
            cmd = [
                self.binary_path,
                "--enable-rpc",
                "--rpc-listen-all=false",
                f"--rpc-listen-port={self.port}",
                "--rpc-max-request-size=2M",
                "--max-concurrent-downloads=20",
                "--check-certificate=false",
                "--daemon=false" # We manage the process ourselves
            ]
            if self.secret:
                cmd.append(f"--rpc-secret={self.secret}")

            # Start process without showing window on Windows
            startupinfo = None
            if os.name == 'nt':
                startupinfo = subprocess.STARTUPINFO()
                startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW

            self.process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                startupinfo=startupinfo,
                text=True
            )
            
            # Wait for port to open
            timeout = 5
            start = time.time()
            while time.time() - start < timeout:
                if self.is_running():
                    break
                time.sleep(0.5)
            else:
                raise Exception("aria2c daemon failed to start or port 6800 is blocked.")

        # Initialize aria2p API
        client = aria2p.Client(host="http://localhost", port=self.port, secret=self.secret)
        self.api = aria2p.API(client)
        print("[+] aria2p API connected.")
        return self.api

    def is_running(self):
        """Checks if a service is listening on the RPC port."""
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            return s.connect_ex(('localhost', self.port)) == 0

    def stop_daemon(self):
        """Kills the aria2c process."""
        if self.process:
            print("[*] Shutting down aria2c daemon...")
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
            self.process = None

    def __enter__(self):
        self.start_daemon()
        return self.api

    def __exit__(self, *_):
        self.stop_daemon()
