import { spawn } from "bun";
import { type ProcessInfo } from "./types";

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";

export async function getAllTcpPorts(): Promise<Map<number, number>> {
    const portMap = new Map<number, number>();

    try {
        if (isWin) {
            return await getPortsWindows();
        } else if (isMac) {
            return await getPortsMac();
        } else if (isLinux) {
            return await getPortsLinux();
        }
    } catch (error) {
        console.error("Error gathering ports:", error);
    }
    return portMap;
}

export async function getProcessInfo(pid: number): Promise<ProcessInfo | null> {
    try {
        if (isWin) {
            return await getProcessInfoWindows(pid);
        } else {
            return await getProcessInfoUnix(pid);
        }
    } catch (e) {
        return null;
    }
}

export async function killProcess(pid: number, force = false): Promise<boolean> {
    try {
        if (isWin) {
            const args = ["/PID", pid.toString()];
            if (force) args.push("/F");
            const proc = spawn(["taskkill", ...args], { stdout: "ignore", stderr: "ignore" });
            const exitCode = await proc.exited;
            return exitCode === 0;
        } else {
            // Unix (Mac/Linux)
            const args = force ? ["-9", pid.toString()] : [pid.toString()];
            const proc = spawn(["kill", ...args], { stdout: "ignore", stderr: "ignore" });
            const exitCode = await proc.exited;
            return exitCode === 0;
        }
    } catch (e) {
        return false;
    }
}

// --- Platform Specific Implementations ---

async function getPortsWindows(): Promise<Map<number, number>> {
    const portMap = new Map<number, number>();
    const proc = spawn(["netstat", "-ano", "-p", "TCP"], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    const lines = output.split(/[\r\n]+/);

    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5 || parts[3] !== 'LISTENING') continue;
        const localAddress = parts[1];
        const pid = parseInt(parts[4], 10);
        const portMatch = localAddress.match(/:(\d+)$/);
        if (portMatch) {
            portMap.set(parseInt(portMatch[1], 10), pid);
        }
    }
    return portMap;
}

async function getPortsMac(): Promise<Map<number, number>> {
    const portMap = new Map<number, number>();
    // lsof -iTCP -sTCP:LISTEN -P -n
    // COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
    const proc = spawn(["lsof", "-iTCP", "-sTCP:LISTEN", "-P", "-n"], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    const lines = output.split(/[\r\n]+/);

    for (const line of lines) {
        if (line.startsWith('COMMAND')) continue;
        const parts = line.trim().split(/\s+/);
        if (parts.length < 9) continue; 
        
        const pid = parseInt(parts[1], 10);
        const address = parts[8]; // *:3000 or 127.0.0.1:3000
        const portMatch = address.match(/:(\d+)$/);
        
        if (portMatch && !isNaN(pid)) {
            portMap.set(parseInt(portMatch[1], 10), pid);
        }
    }
    return portMap;
}

async function getPortsLinux(): Promise<Map<number, number>> {
    const portMap = new Map<number, number>();
    // ss -lptn
    // State Recv-Q Send-Q Local Address:Port Peer Address:Port Process
    // LISTEN 0 128 *:3000 *:* users:(("node",pid=123,fd=19))
    const proc = spawn(["ss", "-lptn"], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    const lines = output.split(/[\r\n]+/);

    for (const line of lines) {
        if (line.startsWith('State')) continue;
        const parts = line.trim().split(/\s+/);
        if (parts.length < 6) continue;

        const localAddress = parts[3];
        const processInfo = parts.slice(5).join(' '); // users:(("node",pid=123,fd=19))
        
        const portMatch = localAddress.match(/:(\d+)$/);
        const pidMatch = processInfo.match(/pid=(\d+)/);

        if (portMatch && pidMatch) {
            portMap.set(parseInt(portMatch[1], 10), parseInt(pidMatch[1], 10));
        }
    }
    return portMap;
}

async function getProcessInfoUnix(pid: number): Promise<ProcessInfo | null> {
    const proc = spawn(["ps", "-p", pid.toString(), "-o", "command="], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    const command = output.trim();
    
    if (!command) return null;
    
    return {
        pid,
        command
    };
}

async function getProcessInfoWindows(pid: number): Promise<ProcessInfo | null> {
    const proc = spawn(["wmic", "process", "where", `processid=${pid}`, "get", "commandline,name", "/format:csv"], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const lines = output.trim().split(/[\r\n]+/);
    if (lines.length < 2) return null;
    const dataLine = lines.find(l => l.includes(pid.toString()) || (l.trim().length > 0 && !l.includes('CommandLine')));
    if (!dataLine) return null;
    return {
        pid,
        command: dataLine,
    };
}
