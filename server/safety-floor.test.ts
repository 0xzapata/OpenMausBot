// The never-list is a string classifier: every case here only calls
// floorVerdict with a command line. Nothing in this file runs a command.
import { describe, expect, it } from "vitest";

import { floorVerdict } from "./safety-floor.ts";

type Case = [command: string, rule: string, platform?: NodeJS.Platform];

const BLOCKED: Case[] = [
  // the filesystem root, in every flag spelling
  ["rm -rf /", "delete-root"],
  ["rm -fr /", "delete-root"],
  ["rm -r /", "delete-root"],
  ["rm -R /", "delete-root"],
  ["rm -Rf /", "delete-root"],
  ["rm --recursive /", "delete-root"],
  ["rm --recursive --force /", "delete-root"],
  ["rm -r -f /", "delete-root"],
  ["rm -f -r /", "delete-root"],
  ["rm / -rf", "delete-root"],
  ["rm -rfv /", "delete-root"],
  ["rm -rf /*", "delete-root"],
  ["rm -rf --no-preserve-root /", "delete-root"],
  ["rm --no-preserve-root -rf /", "delete-root"],
  ["rm -rf -- /", "delete-root"],
  ["rm -rf /tmp/scratch /", "delete-root"],
  // quotes, trailing slashes and dot segments
  ['rm -rf "/"', "delete-root"],
  ["rm -rf '/'", "delete-root"],
  ["rm -rf //", "delete-root"],
  ["rm -rf /.", "delete-root"],
  ["rm -rf /..", "delete-root"],
  ["rm -rf /./", "delete-root"],
  ["rm -rf /usr/..", "delete-root"],
  ["rm -rf /tmp/../", "delete-root"],
  ['rm -rf "/"*', "delete-root"],
  // the home directory itself
  ["rm -rf ~", "delete-home"],
  ["rm -rf ~/", "delete-home"],
  ["rm -rf ~/.", "delete-home"],
  ["rm -rf ~/*", "delete-home"],
  ["rm -rf $HOME", "delete-home"],
  ['rm -rf "$HOME"', "delete-home"],
  ["rm -rf ${HOME}", "delete-home"],
  ['rm -rf "${HOME}/"', "delete-home"],
  ["rm -rf $HOME/*", "delete-home"],
  ["rm -rf ~/Documents/..", "delete-home"],
  ["rm -rf ~/..", "delete-home"],
  // top-level system directories
  ["rm -rf /etc", "delete-system-directory"],
  ["rm -rf /etc/", "delete-system-directory"],
  ["rm -rf '/etc'", "delete-system-directory"],
  ["rm -rf /usr", "delete-system-directory"],
  ["rm -rf /bin", "delete-system-directory"],
  ["rm -rf /sbin", "delete-system-directory"],
  ["rm -rf /var", "delete-system-directory"],
  ["rm -rf /var/*", "delete-system-directory"],
  ["rm -rf /System", "delete-system-directory"],
  ["rm -rf /Library", "delete-system-directory"],
  ["rm -rf /Applications", "delete-system-directory"],
  ["rm -rf /Users", "delete-system-directory"],
  ["rm -rf /home", "delete-system-directory"],
  ["rm -rf /boot", "delete-system-directory"],
  ["rm -rf /lib", "delete-system-directory"],
  ["rm -rf /lib64", "delete-system-directory"],
  ["rm -rf /lib*", "delete-system-directory"],
  ["rm -rf /private/var", "delete-system-directory"],
  ["rm -rf /tmp/../etc", "delete-system-directory"],
  ["rm -rf /usr/local/..", "delete-system-directory"],
  ["rm -rf /users", "delete-system-directory", "darwin"],
  ["rm -rf /ETC", "delete-system-directory", "darwin"],
  // prefixes and wrappers
  ["sudo rm -rf /", "delete-root"],
  ["sudo -n rm -rf /", "delete-root"],
  ["sudo -u root rm -rf /etc", "delete-system-directory"],
  ["sudo --user root rm -rf /", "delete-root"],
  ["doas rm -rf /", "delete-root"],
  ["doas -u root rm -rf ~", "delete-home"],
  ["FORCE=1 rm -rf /", "delete-root"],
  ['A=1 B="two words" rm -rf /usr', "delete-system-directory"],
  ["env FOO=bar rm -rf /", "delete-root"],
  ["nohup rm -rf / &", "delete-root"],
  ["command rm -rf /", "delete-root"],
  ["exec rm -rf /", "delete-root"],
  ["/bin/rm -rf /", "delete-root"],
  ["\\rm -rf /", "delete-root"],
  ["'rm' -rf /", "delete-root"],
  ["sh -c 'rm -rf /'", "delete-root"],
  ['bash -lc "rm -rf /"', "delete-root"],
  ['bash -c "rm -rf $HOME"', "delete-home"],
  ["bash -c 'rm -rf \"$HOME\"'", "delete-home"],
  ["zsh -ic 'sudo rm -rf /etc'", "delete-system-directory"],
  ["bash -o pipefail -c 'rm -rf /'", "delete-root"],
  ["sudo sh -c \"bash -c 'rm -rf /'\"", "delete-root"],
  ["eval 'rm -rf /'", "delete-root"],
  // chains
  ["ls; rm -rf /", "delete-root"],
  ["cd /tmp && rm -rf /", "delete-root"],
  ["test -d x || rm -rf /", "delete-root"],
  ["yes | rm -rf /", "delete-root"],
  ["echo start\nrm -rf /\necho done", "delete-root"],
  ["rm -rf /;echo done", "delete-root"],
  ["(rm -rf /)", "delete-root"],
  ["{ rm -rf /; }", "delete-root"],
  ["if true; then rm -rf /; fi", "delete-root"],
  ["echo $(rm -rf /)", "delete-root"],
  ["echo `rm -rf ~`", "delete-home"],
  ["rm -rf \\\n  /", "delete-root"],
  // formatting or overwriting a disk
  ["mkfs.ext4 /dev/sda1", "format-disk"],
  ["sudo mkfs -t xfs /dev/nvme0n1p1", "format-disk"],
  ["mkfs.vfat -F 32 /dev/sdb", "format-disk"],
  ["diskutil eraseDisk JHFS+ Untitled /dev/disk2", "format-disk"],
  ["diskutil erasedisk APFS Data disk3", "format-disk"],
  ["diskutil eraseVolume APFS Scratch disk3s1", "format-disk"],
  ["sudo diskutil reformat disk2s1", "format-disk"],
  ["dd if=/dev/zero of=/dev/sda bs=1M", "overwrite-disk"],
  ["dd of=/dev/rdisk2 if=ubuntu.iso bs=4m", "overwrite-disk"],
  ["sudo dd if=image.img of=/dev/nvme0n1 status=progress", "overwrite-disk"],
  ['dd if=/dev/urandom of="/dev/hda"', "overwrite-disk"],
  ["dd if=x of=/dev/disk0", "overwrite-disk"],
  ["cat image.img > /dev/sda", "overwrite-disk"],
  ["echo boom >/dev/disk0", "overwrite-disk"],
  ["gunzip -c image.gz >> /dev/nvme0n1", "overwrite-disk"],
  ["true && : > /dev/sdb1", "overwrite-disk"],
  // fork bombs
  [":(){ :|:& };:", "fork-bomb"],
  [":() { : | : & } ; :", "fork-bomb"],
  ["bomb() { bomb | bomb & }; bomb", "fork-bomb"],
  ["function f { f | f & }; f", "fork-bomb"],
  ["bash -c ':(){ :|:& };:'", "fork-bomb"],
  // Windows: cmd
  ["rd /s /q C:\\", "delete-root"],
  ["rmdir /s /q C:\\", "delete-root"],
  ["RD /S /Q D:\\", "delete-root"],
  ["rd /s/q C:", "delete-root"],
  ['rd /s /q "C:\\"', "delete-root"],
  ["rd /s /q %USERPROFILE%", "delete-home"],
  ['rmdir /s /q "%USERPROFILE%"', "delete-home"],
  ["rd /s /q C:\\Windows", "delete-system-directory"],
  ["rmdir /S /Q C:\\Users", "delete-system-directory"],
  ['rd /s /q "C:\\Program Files"', "delete-system-directory"],
  ["rd /s /q C:\\Windows\\", "delete-system-directory"],
  ["rd /s /q %SystemRoot%", "delete-system-directory"],
  ["del /s /q C:\\*", "delete-root"],
  ["del /f /s /q C:\\Users", "delete-system-directory"],
  ["del /s /q C:\\Windows\\*.*", "delete-system-directory"],
  ["echo cleaning & rd /s /q C:\\", "delete-root"],
  ["cmd /c rd /s /q C:\\", "delete-root"],
  ['cmd.exe /c "rd /s /q C:\\Users"', "delete-system-directory"],
  ["format C:", "format-disk"],
  ["format D: /FS:NTFS /Q", "format-disk"],
  // Windows: PowerShell
  ["Remove-Item -Recurse -Force C:\\", "delete-root"],
  ["Remove-Item C:\\Users -Recurse", "delete-system-directory"],
  ['Remove-Item -Recurse -Force "C:\\Program Files"', "delete-system-directory"],
  ["Remove-Item -Path C:\\Windows -Recurse -Force", "delete-system-directory"],
  ["Remove-Item -Recurse $env:USERPROFILE", "delete-home"],
  ['Remove-Item -Recurse -Force "$env:USERPROFILE"', "delete-home"],
  ["Remove-Item -Recurse -Force $HOME", "delete-home"],
  ["ri -r C:\\Windows", "delete-system-directory"],
  ["remove-item -rec c:\\", "delete-root"],
  ['powershell -Command "Remove-Item -Recurse -Force C:\\"', "delete-root"],
  ["pwsh -c 'Remove-Item -Recurse $HOME'", "delete-home"],
  ["powershell.exe -NoProfile -Command Remove-Item -Recurse C:\\Users", "delete-system-directory"],
  ["rm -r -fo C:\\", "delete-root", "win32"],
  ["rm -Recurse -Force C:\\Windows", "delete-system-directory", "win32"],
  // Windows: Git Bash and WSL spellings of a drive
  ["rm -rf /c", "delete-root", "win32"],
  ["rm -rf /c/Users", "delete-system-directory", "win32"],
  ["rm -rf /mnt/c", "delete-root", "linux"],
  ["rm -rf '/mnt/c/Program Files'", "delete-system-directory", "linux"],
  // spellings found by probing, kept so they stay blocked
  ["RM -rf /", "delete-root"],
  ["rm -rf / >/dev/null 2>&1 &", "delete-root"],
  ["rm -rf / # clean", "delete-root"],
  ["timeout 10 rm -rf /", "delete-root"],
  ["sudo -E env PATH=/x rm -rf /", "delete-root"],
  ["while true; do rm -rf /; done", "delete-root"],
  ["case x in x) rm -rf / ;; esac", "delete-root"],
  ["x=$(rm -rf /usr)", "delete-system-directory"],
  ["dd if=/dev/zero of=/dev/disk/by-id/ata-X", "overwrite-disk"],
  ["dd if=x of=/dev/vda", "overwrite-disk"],
  ["cat x &> /dev/sdb", "overwrite-disk"],
  ["diskutil apfs eraseVolume disk1s2 -name X", "format-disk"],
  ["Remove-Item -Recurse -Force C:\\\\", "delete-root"],
  ["Remove-Item -Recurse -Force C:/", "delete-root"],
  ["Remove-Item -Recurse C:\\; echo done", "delete-root"],
  ["rd /s /q C:\\Users\\..", "delete-root"],
  ["rd /s /q %SystemDrive%\\", "delete-root"],
  ['rd /s /q "C:\\Program Files (x86)"', "delete-system-directory"],
  ['pwsh -NoProfile -Command "& { Remove-Item -Recurse -Force C:\\Users }"', "delete-system-directory"],
  ['powershell -c "rm -r -fo C:\\"', "delete-root"],
];

const ALLOWED: Array<[command: string, platform?: NodeJS.Platform]> = [
  // the same text as data
  ['git commit -m "rm -rf /"'],
  ["git commit -m 'never run: rm -rf ~'"],
  ['echo "rm -rf ~"'],
  ["echo rm -rf /"],
  ["printf '%s\\n' 'rm -rf /' > notes.txt"],
  ["grep -r 'mkfs' ."],
  ['rg "dd if=/dev/zero of=/dev/sda" docs'],
  ['git log --grep="rm -rf /"'],
  ["echo ':(){ :|:& };:'"],
  ['echo "format C:"'],
  ['Write-Output "rd /s /q C:\\"'],
  ["# rm -rf /"],
  ["ls -la # then rm -rf /"],
  ["cat <<'EOF' > cleanup-notes.md\nNever run:\nrm -rf /\nEOF"],
  ["cat <<EOF\nrm -rf ~\nmkfs.ext4 /dev/sda1\nEOF\necho written"],
  ["git commit -m \"$(cat <<'EOF'\nfix: don't run rm -rf / in the installer\n\nIt was wrong; dd of=/dev/sda was worse.\nEOF\n)\""],
  ['echo "a \\" ; rm -rf / ; \\" b"'],
  ['echo "${X:-"}"}; rm -rf /"'],
  ['git commit -m "docs: warn that \\"; rd /s /q C:\\\\ \\" is dangerous"'],
  ["cat <<< 'rm -rf /'"],
  ["cat <<-EOF\n\trm -rf /\n\tEOF"],
  ['cmd=(rm -rf /tmp/x); "${cmd[@]}"'],
  ["alias nuke='rm -rf /'"],
  ['export CLEAN_CMD="rm -rf /"'],
  ["bash -c 'echo \"rm -rf /\"'"],
  ["bash script.sh -c 'rm -rf /'"],
  ["docker run --rm alpine rm -rf /"],
  ["ssh build-host 'rm -rf /'"],
  ["man rm"],
  ["which rm mkfs dd"],
  ["command -v rm"],
  // deleting a subdirectory
  ["rm -rf ./build"],
  ["rm -rf build dist .cache node_modules"],
  ["rm -rf ~/project/dist"],
  ["rm -rf ~/.cache/pip"],
  ["rm -rf /tmp/x"],
  ["rm -rf /tmp/*"],
  ["rm -rf /var/folders/ab/cd/T/vitest-123"],
  ["rm -rf /private/var/folders/ab/cd/T/vitest-123"],
  ["rm -rf /private/tmp/claude-501/scratch"],
  ["sudo rm -rf /var/lib/apt/lists/*"],
  ["rm -rf /usr/local/lib/node_modules/typescript"],
  ["rm -rf /Applications/Example.app"],
  ["rm -rf /Library/Caches/com.example.app"],
  ["rm -rf /Users/omkar/project/dist"],
  ["rm -rf /home/omkar/project/.next"],
  ["rm -rf /opt/homebrew/Cellar/example"],
  ["rm -rf /etc/../tmp/y"],
  ["rm -rf /../tmp/x"],
  ["rm -rf /users", "linux"],
  ["rm -rf /c", "linux"],
  // not recursive, or not a delete at all
  ["rm /"],
  ["rm -f /etc/hosts.bak"],
  ["rm -f ~/notes.txt"],
  ["rmdir /tmp/empty"],
  ["mkdir -p /etc/foo"],
  ["ls -R /"],
  ["du -sh /*"],
  ["find / -name '*.log'"],
  ["cd / && ls"],
  ["chmod -R 755 /usr/local/share/example"],
  // a directory that is only named like the dangerous one
  ["rm -rf '~'"],
  ['rm -rf "~"'],
  ["rm -rf ./~"],
  ["rm -rf \\~"],
  ["rm -rf '$HOME'"],
  ["rm -rf C:", "darwin"],
  ['rm -rf "%USERPROFILE%"', "darwin"],
  ['rm -rf "%USERPROFILE%"', "win32"],
  // a path nobody can know from the text
  ['rm -rf "$DIR"'],
  ["rm -rf $BUILD_DIR/"],
  ['rm -rf "${TMPDIR:-/tmp}/work"'],
  ['rm -rf "$(mktemp -d)"'],
  ["rm -rf /$NAME"],
  ["rm -rf ~/../shared-scratch"],
  ["rm -rf ~other"],
  // disks: reading, files and pseudo-devices
  ["dd of=./image.bin"],
  ["dd if=/dev/zero of=/tmp/blank.img bs=1M count=10"],
  ["dd if=/dev/sda of=backup.img"],
  ["dd if=image.iso of=/dev/null"],
  ["cat /dev/sda > disk.img"],
  ["echo done > /dev/null"],
  ["ls 2>/dev/null >&2"],
  ["echo hi > /dev/stderr"],
  ["mkfs.ext4 rootfs.img"],
  ["mkfs.fat -F 32 /dev/loop0p1"],
  ["diskutil list"],
  ["diskutil info /"],
  ["diskutil erasevolume HFS+ 'RAM Disk' $(hdiutil attach -nomount ram://2097152)"],
  ["npm run format"],
  ["prettier --write src && clang-format -i a.c"],
  // a function that is not a fork bomb
  ["build() { make | tee log & }; build"],
  // Windows
  ["rd /s /q build"],
  ["rmdir /s /q .\\dist"],
  ["rd /s /q C:\\Users\\omkar\\project\\node_modules"],
  ["rd /s /q %TEMP%\\scratch"],
  ["rd /s /q %USERPROFILE%\\Downloads\\old"],
  ["rd C:\\Windows"],
  ["del /s /q *.tmp"],
  ["del /s /q C:\\Temp\\*"],
  ["del C:\\Windows\\Temp\\a.log"],
  ["Remove-Item -Recurse -Force .\\node_modules"],
  ["Remove-Item -Recurse $env:TEMP\\work"],
  ['Remove-Item -Recurse "$env:USERPROFILE\\Downloads\\old"'],
  ["Remove-Item -Recurse '$HOME'"],
  ["Remove-Item C:\\Windows\\Temp\\a.log"],
  ["Get-ChildItem C:\\ -Recurse"],
  ["dir C:\\Windows"],
  ["Format-Table -AutoSize"],
  ["cmd /c echo rd /s /q C:\\"],
  ["rd /s /q C:\\\\Users\\\\omkar\\\\project\\\\dist"],
  ["rd /s /q \\\\server\\share\\old"],
  ["rmdir /srv/s /etc"],
  ['powershell -Command "Write-Host \'rd /s /q C:\\\'"'],
  ["rm -rf /c/Users/omkar/project/node_modules", "win32"],
  ["rm -rf C:\\Users\\omkar\\project\\dist", "win32"],
  ["rm -rf /tmp/build", "win32"],
];

describe("floorVerdict", () => {
  it("covers at least forty spellings each way", () => {
    expect(BLOCKED.length).toBeGreaterThanOrEqual(40);
    expect(ALLOWED.length).toBeGreaterThanOrEqual(40);
  });

  it.each(BLOCKED)("blocks %j as %s", (command, rule, platform) => {
    const verdict = floorVerdict(command, platform ?? "linux");
    expect(verdict, command).not.toBeNull();
    expect(verdict!.rule).toBe(rule);
    expect(verdict!.label).toMatch(/\S/);
  });

  it.each(ALLOWED)("allows %j", (command, platform) => {
    expect(floorVerdict(command, platform ?? "linux"), command).toBeNull();
  });

  it("reads every spelling the same on each platform unless the platform decides it", () => {
    for (const [command, rule, platform] of BLOCKED) {
      if (platform) continue;
      for (const host of ["darwin", "linux", "win32"] as const) expect(floorVerdict(command, host)?.rule, `${host}: ${command}`).toBe(rule);
    }
    for (const [command, platform] of ALLOWED) {
      if (platform) continue;
      for (const host of ["darwin", "linux", "win32"] as const) expect(floorVerdict(command, host), `${host}: ${command}`).toBeNull();
    }
  });

  it("names what it blocked without repeating the command", () => {
    expect(floorVerdict("rm -rf /")).toEqual({ rule: "delete-root", label: "recursive delete of the filesystem root" });
    expect(floorVerdict("rm -rf ~")).toEqual({ rule: "delete-home", label: "recursive delete of the home directory" });
    expect(floorVerdict("sudo rm -rf /etc/")).toEqual({ rule: "delete-system-directory", label: "recursive delete of /etc" });
    expect(floorVerdict("rd /s /q C:\\Windows")?.label).toBe("recursive delete of a Windows system folder (Windows)");
    expect(floorVerdict("mkfs.ext4 /dev/sda1")?.label).toBe("formatting a disk");
    expect(floorVerdict("dd if=x of=/dev/sda")?.label).toBe("overwriting a disk device");
    expect(floorVerdict(":(){ :|:& };:")?.label).toBe("a fork bomb");
    const secret = floorVerdict("TOKEN=sk-live-1234567890 rm -rf /");
    expect(JSON.stringify(secret)).not.toContain("sk-live");
  });

  it("knows the home directory by its absolute path when it is told where home is", () => {
    expect(floorVerdict("rm -rf /Users/omkar", "darwin")).toBeNull();
    expect(floorVerdict("rm -rf /Users/omkar", "darwin", "/Users/omkar")?.rule).toBe("delete-home");
    expect(floorVerdict("rm -rf /Users/omkar/", "darwin", "/Users/omkar/")?.rule).toBe("delete-home");
    expect(floorVerdict("rm -rf /users/OMKAR/*", "darwin", "/Users/omkar")?.rule).toBe("delete-home");
    expect(floorVerdict("rm -rf /home/omkar", "linux", "/home/omkar")?.rule).toBe("delete-home");
    expect(floorVerdict("rm -rf /home/Omkar", "linux", "/home/omkar")).toBeNull();
    expect(floorVerdict("rm -rf /Users/omkar/project", "darwin", "/Users/omkar")).toBeNull();
    expect(floorVerdict("rd /s /q C:\\Users\\Omkar", "win32", "C:\\Users\\omkar")?.rule).toBe("delete-home");
    expect(floorVerdict("rm -rf /c/Users/omkar", "win32", "C:\\Users\\omkar")?.rule).toBe("delete-home");
    expect(floorVerdict("rd /s /q C:\\Users\\omkar\\project", "win32", "C:\\Users\\omkar")).toBeNull();
  });

  it("never throws and never blocks text it cannot read", () => {
    const odd = [
      "", "   ", "\n\n", "'", '"', "`", "$(", "${", "rm -rf '", 'rm -rf "', "rm -rf $(", "<<", "<<EOF", ">", "2>&", "&&&&", "((((", "))))",
      "rm", "rm -rf", "sudo", "sudo -u", "env", "bash -c", "cmd /c", "powershell -Command", "\u0000rm -rf /tmp/x", "rm -rf \uE000", "rm -rf \uE001",
      "$(".repeat(5_000), "(".repeat(20_000), "a".repeat(200_000), `echo ${"x ".repeat(50_000)}`, "bash -c ".repeat(2_000) + "true",
    ];
    for (const command of odd) expect(() => floorVerdict(command), command.slice(0, 40)).not.toThrow();
    for (const command of odd) expect(floorVerdict(command), command.slice(0, 40)).toBeNull();
    expect(floorVerdict(undefined as unknown as string)).toBeNull();
    expect(floorVerdict(42 as unknown as string)).toBeNull();
  });
});
