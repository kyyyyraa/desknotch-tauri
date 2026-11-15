//! Dev probe: print the native privacy sensor state.
use desknotch_lib::privacy;

fn main() {
    // 30 days: shows the "recently used" list regardless of when it happened.
    let st = privacy::read_state(30 * 86_400);
    println!("mic: {}", st.mic);
    println!("camera: {}", st.camera);
    println!("micApps(30d): {:?}", st.mic_apps);
    println!("cameraApps(30d): {:?}", st.camera_apps);
}
