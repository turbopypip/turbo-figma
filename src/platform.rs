//! Small OS boundary. No extra runtime or crate is needed on either platform.
use std::{
    fs, io,
    path::{Path, PathBuf},
};

pub fn canonicalize(path: impl AsRef<Path>) -> io::Result<PathBuf> {
    let path = fs::canonicalize(path)?;
    #[cfg(windows)]
    {
        // Match Node realpath's normal DOS/UNC spelling at the JSON boundary.
        use std::path::{Component, Prefix};
        let mut components = path.components();
        if let Some(Component::Prefix(prefix)) = components.next() {
            match prefix.kind() {
                Prefix::VerbatimDisk(drive) => {
                    let mut result = PathBuf::from(format!("{}:\\", drive as char));
                    for c in components {
                        if !matches!(c, Component::RootDir) {
                            result.push(c.as_os_str());
                        }
                    }
                    return Ok(result);
                }
                Prefix::VerbatimUNC(server, share) => {
                    let mut result = PathBuf::from(r"\\");
                    result.push(server);
                    result.push(share);
                    for c in components {
                        if !matches!(c, Component::RootDir) {
                            result.push(c.as_os_str());
                        }
                    }
                    return Ok(result);
                }
                _ => {}
            }
        }
    }
    Ok(path)
}

#[cfg(unix)]
pub fn random(bytes: &mut [u8]) -> io::Result<()> {
    use std::io::Read;
    fs::File::open("/dev/urandom")?.read_exact(bytes)
}

#[cfg(windows)]
pub use windows::*;

#[cfg(windows)]
mod windows {
    use std::{
        ffi::c_void,
        fs::{File, OpenOptions},
        io,
        mem::MaybeUninit,
        os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
        path::Path,
        sync::{
            atomic::{AtomicBool, Ordering},
            OnceLock,
        },
    };

    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    struct HandleInfo {
        attributes: u32,
        created: FileTime,
        accessed: FileTime,
        written: FileTime,
        volume: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct SystemTime {
        year: u16,
        month: u16,
        weekday: u16,
        day: u16,
        hour: u16,
        minute: u16,
        second: u16,
        millis: u16,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(file: *mut c_void, info: *mut HandleInfo) -> i32;
        fn GetSystemTime(time: *mut SystemTime);
        fn SetConsoleCtrlHandler(
            handler: Option<unsafe extern "system" fn(u32) -> i32>,
            add: i32,
        ) -> i32;
    }
    #[link(name = "bcrypt")]
    extern "system" {
        fn BCryptGenRandom(algorithm: *mut c_void, buffer: *mut u8, size: u32, flags: u32) -> i32;
    }
    pub struct FileInfo {
        pub volume: u32,
        pub index: u64,
        pub links: u32,
    }
    pub fn file_info(file: &File) -> io::Result<FileInfo> {
        let mut info = MaybeUninit::<HandleInfo>::uninit();
        // The OS fills exactly BY_HANDLE_FILE_INFORMATION; File owns the handle.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let info = unsafe { info.assume_init() };
        if info.attributes & 0x400 != 0 {
            // FILE_ATTRIBUTE_REPARSE_POINT
            return Err(io::Error::other(
                "Unsafe cache file or directory: reparse point",
            ));
        }
        Ok(FileInfo {
            volume: info.volume,
            index: (u64::from(info.index_high) << 32) | u64::from(info.index_low),
            links: info.links,
        })
    }
    pub fn open_read(path: &Path, directory: bool) -> io::Result<File> {
        let file = OpenOptions::new()
            .read(true)
            // OPEN_REPARSE_POINT avoids following a replaced final symlink;
            // BACKUP_SEMANTICS permits opening a directory without elevation.
            .custom_flags(0x00200000 | if directory { 0x02000000 } else { 0 })
            .open(path)?;
        file_info(&file)?;
        Ok(file)
    }
    pub fn random(bytes: &mut [u8]) -> io::Result<()> {
        let size =
            u32::try_from(bytes.len()).map_err(|_| io::Error::other("Random buffer too large"))?;
        // BCRYPT_USE_SYSTEM_PREFERRED_RNG; NTSTATUS < 0 means failure.
        let status = unsafe { BCryptGenRandom(std::ptr::null_mut(), bytes.as_mut_ptr(), size, 2) };
        if status < 0 {
            return Err(io::Error::other(format!(
                "BCryptGenRandom failed: {status:#x}"
            )));
        }
        Ok(())
    }
    pub fn utc_now() -> String {
        let mut t = SystemTime::default();
        unsafe { GetSystemTime(&mut t) };
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            t.year, t.month, t.day, t.hour, t.minute, t.second, t.millis
        )
    }
    static STOP: OnceLock<&'static AtomicBool> = OnceLock::new();
    unsafe extern "system" fn console_control(event: u32) -> i32 {
        if matches!(event, 0 | 1 | 2 | 5 | 6) {
            if let Some(stop) = STOP.get() {
                stop.store(true, Ordering::Relaxed);
            }
            return 1;
        }
        0
    }
    pub fn install_shutdown_handler(stop: &'static AtomicBool) -> io::Result<()> {
        let _ = STOP.set(stop);
        if unsafe { SetConsoleCtrlHandler(Some(console_control), 1) } == 0 {
            let error = io::Error::last_os_error();
            // GUI-launched MCP may have no console. Its normal shutdown is stdin EOF.
            if error.raw_os_error() != Some(6) {
                return Err(error);
            }
        }
        Ok(())
    }
}
