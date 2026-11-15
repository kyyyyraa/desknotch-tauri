// Probe: baca posisi SMTC 20x @500ms persis seperti ticker lirik.
use desknotch_lib::smtc::read_position_once;
use std::ffi::c_void;

#[link(name = "ole32")]
extern "system" {
    fn CoInitializeEx(pvReserved: *mut c_void, dwCoInit: u32) -> i32;
}

fn main() {
    unsafe {
        CoInitializeEx(std::ptr::null_mut(), 0); // COINIT_MULTITHREADED
    }
    let manager_op = match windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
        Ok(o) => o,
        Err(e) => { println!("RequestAsync ERR {:?}", e); return; }
    };
    let manager = match manager_op.get() {
        Ok(m) => m,
        Err(e) => { println!("manager get ERR {:?}", e); return; }
    };
    for i in 0..120 {
        match read_position_once(&manager) {
            Some(v) => println!("#{} {}", i, v),
            None => println!("#{} None", i),
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}
