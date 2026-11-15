use windows::core::*;
use windows::Win32::System::WinRT::*;
use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager;

fn main() -> Result<()> {
    unsafe {
        RoInitialize(RO_INIT_MULTITHREADED)?;
    }
    println!("RoInitialize succeeded!");

    let op = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()?;
    let mgr = op.get()?;
    println!("Manager acquired!");

    match mgr.GetCurrentSession() {
        Ok(s) => {
            let app = s.SourceAppUserModelId()?.to_string();
            println!("CurrentSession: {}", app);
        }
        Err(e) => println!("GetCurrentSession err: {:?}", e),
    }

    let sessions = mgr.GetSessions()?;
    let count = sessions.Size()?;
    println!("Sessions count: {}", count);
    for i in 0..count {
        let s = sessions.GetAt(i)?;
        let app = s.SourceAppUserModelId()?.to_string();
        let props = s.TryGetMediaPropertiesAsync()?.get()?;
        let title = props.Title()?.to_string();
        let artist = props.Artist()?.to_string();
        println!("  [{}] App: {}, Title: {}, Artist: {}", i, app, title, artist);
    }

    Ok(())
}
