use std::ffi::c_void;
use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager;

#[link(name = "ole32")]
extern "system" {
    fn CoInitializeEx(pvReserved: *mut c_void, dwCoInit: u32) -> i32;
}

fn main() {
    unsafe {
        let hr = CoInitializeEx(std::ptr::null_mut(), 0); // COINIT_MULTITHREADED
        println!("CoInitializeEx hr: 0x{:08X}", hr);
    }

    match GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
        Ok(op) => match op.get() {
            Ok(mgr) => {
                match mgr.GetCurrentSession() {
                    Ok(session) => {
                        let app = session.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default();
                        println!("Current session found! App: {}", app);
                        if let Ok(prop_op) = session.TryGetMediaPropertiesAsync() {
                            if let Ok(props) = prop_op.get() {
                                let title = props.Title().map(|h| h.to_string()).unwrap_or_default();
                                let artist = props.Artist().map(|h| h.to_string()).unwrap_or_default();
                                println!("Title: {}, Artist: {}", title, artist);
                            }
                        }
                    }
                    Err(e) => println!("GetCurrentSession returned Err: {:?}", e),
                }
                match mgr.GetSessions() {
                    Ok(sessions) => {
                        let count = sessions.Size().unwrap_or(0);
                        println!("Total sessions count: {}", count);
                        for i in 0..count {
                            if let Ok(sess) = sessions.GetAt(i) {
                                let app = sess.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default();
                                println!("  Session [{}]: App: {}", i, app);
                                if let Ok(prop_op) = sess.TryGetMediaPropertiesAsync() {
                                    if let Ok(props) = prop_op.get() {
                                        let title = props.Title().map(|h| h.to_string()).unwrap_or_default();
                                        let artist = props.Artist().map(|h| h.to_string()).unwrap_or_default();
                                        println!("    Title: {}, Artist: {}", title, artist);
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => println!("GetSessions returned Err: {:?}", e),
                }
            }
            Err(e) => println!("op.get() failed: {:?}", e),
        },
        Err(e) => println!("RequestAsync failed: {:?}", e),
    }
}
