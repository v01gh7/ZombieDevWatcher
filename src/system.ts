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


export async function getMatchingProcesses(filterNames: string[]): Promise<ProcessInfo[]> {
    if (!filterNames || filterNames.length === 0) return [];
    
    // Construct WQL query
    // Name='node.exe' OR Name='bun.exe'
    // Construct WQL query
    let names = filterNames;
    if (isWin) {
        // Automatically append .exe if missing for Windows convenience
        const expanded: string[] = [];
        for (const n of filterNames) {
            expanded.push(n);
            if (!n.endsWith('.exe')) {
                expanded.push(`${n}.exe`);
            }
        }
        names = expanded;
    }
    const clause = names.map(n => `Name='${n}'`).join(" OR ");
    
    try {
        if (isWin) {
            // wmic process where "Name='node.exe' OR Name='bun.exe'" get CommandLine,ProcessId,CreationDate /format:csv
            const cmd = ["wmic", "process", "where", clause, "get", "CommandLine,ProcessId,CreationDate", "/format:csv"];
            
            // Run with timeout race to prevent hanging
            const proc = spawn(cmd, { stdout: "pipe", stderr: "pipe" });
            
            // Timeout promise
            const timeout = new Promise<string>((_, reject) => 
                setTimeout(() => {
                    proc.kill();
                    reject(new Error("Timeout waiting for wmic"));
                }, 5000)
            );

            // Output promise
            const outputPromise = new Response(proc.stdout).text();
            
            const output = await Promise.race([outputPromise, timeout]);
            
            const lines = output.trim().split(/[\r\n]+/);
            const results: ProcessInfo[] = [];

            // CSV Header: Node,CommandLine,CreationDate,ProcessId
            // But order can vary? Usually alphabetical by property name in GET if not CSV?
            // checking wmic csv output: Node,CommandLine,CreationDate,ProcessId
            
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;
                
                // CSV parsing logic (naive split by comma might fail if comma in command line)
                // wmic csv format is usually: Node, "Value1", "Value2", ...
                // But complex command lines might be tricky.
                // Let's rely on the fact that PID and Date are at the end ?? No.
                // We'll use a regex to capture the end parts and the rest is command line.
                
                // Example: DESKTOP-XXX,"C:\path\node.exe args",20240101...,1234
                // The last field is PID (digits). Second to last is Date (digits+dots+zones)
                
                // Regex: ^([^,]+),(.*),(\d{14}\.\d{6}[+-]\d{3}),(\d+)$
                // Note: CommandLine might be empty or unquoted? WMIC usually quotes string fields in CSV.
                
                // A safer robust way for the middle part:
                const parts = line.split(',');
                if (parts.length < 4) continue;
                
                const pidStr = parts[parts.length - 1];
                const dateStr = parts[parts.length - 2];
                // The rest in the middle is CommandLine (joined back just in case it contained commas)
                // Node name is index 0.
                const cmdLine = parts.slice(1, parts.length - 2).join(',');
                
                const pid = parseInt(pidStr, 10);
                if (!isNaN(pid)) {
                    results.push({
                        pid,
                        command: cmdLine.replace(/^"|"$/g, ''), // Strip surrounding quotes from CSV
                        creationDate: dateStr
                    });
                }
            }
            return results;

        } else {
            // Unix implementation (ps -o pid,lstart,command)
            // Need to map names to something `ps` understands or just grep?
            // `ps -A -o pid,lstart,command | grep node`
            const proc = spawn(["ps", "-A", "-o", "pid,lstart,command"], { stdout: "pipe", stderr: "pipe" });
            const output = await new Response(proc.stdout).text();
            const lines = output.split('\n');
            const results: ProcessInfo[] = [];
            
            for (const line of lines) {
                // Parse PID LSTART COMMAND
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('PID')) continue;
                
                // PID is first
                const firstSpace = trimmed.indexOf(' ');
                const pidStr = trimmed.substring(0, firstSpace);
                
                // LSTART is date (e.g. "Mon Feb 19 22:50:00 2026") - Fixed width? usually ~24 chars
                // Command is the rest
                // Actually `ps` output is column based but `lstart` has spaces.
                // Better strategy: filter by name first? 
                
                const pid = parseInt(pidStr, 10);
                if (isNaN(pid)) continue;

                const rest = trimmed.substring(firstSpace).trim();
                // Assume command matches one of the filters
                const matchesFilter = filterNames.some(f => rest.includes(f));
                if (matchesFilter) {
                     results.push({
                         pid,
                         command: rest, // Approx, includes date at start
                         // parsing date from ps output is painful, leaving empty for now or implementing later if needed for linux
                     });
                }
            }
            return results;
        }
    } catch (e) {
        console.error("Error listed processes:", e);
        return [];
    }
}
