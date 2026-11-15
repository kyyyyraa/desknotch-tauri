use base64::prelude::*;
use std::ffi::c_void;

#[repr(C)]
#[allow(non_snake_case)]
struct DATA_BLOB {
    cbData: u32,
    pbData: *mut u8,
}

#[link(name = "crypt32")]
extern "system" {
    fn CryptProtectData(
        pDataIn: *mut DATA_BLOB,
        szDataDescr: *const u16,
        pOptionalEntropy: *mut DATA_BLOB,
        pvReserved: *mut c_void,
        pPromptStruct: *mut c_void,
        dwFlags: u32,
        pDataOut: *mut DATA_BLOB,
    ) -> i32;

    fn CryptUnprotectData(
        pDataIn: *mut DATA_BLOB,
        ppszDataDescr: *mut *mut u16,
        pOptionalEntropy: *mut DATA_BLOB,
        pvReserved: *mut c_void,
        pPromptStruct: *mut c_void,
        dwFlags: u32,
        pDataOut: *mut DATA_BLOB,
    ) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn LocalFree(hMem: *mut c_void) -> *mut c_void;
}

/// Windows DPAPI CryptProtectData to base64 string
pub fn seal_key(plain: &str) -> Result<String, String> {
    if plain.is_empty() {
        return Ok(String::new());
    }
    let mut in_bytes = plain.as_bytes().to_vec();
    let mut in_blob = DATA_BLOB {
        cbData: in_bytes.len() as u32,
        pbData: in_bytes.as_mut_ptr(),
    };
    let mut out_blob = DATA_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    let ok = unsafe {
        CryptProtectData(
            &mut in_blob,
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
            &mut out_blob,
        )
    };

    if ok == 0 {
        return Err("CryptProtectData failed".to_string());
    }

    let encrypted_bytes = unsafe {
        std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize)
    };
    let encoded = BASE64_STANDARD.encode(encrypted_bytes);
    unsafe {
        LocalFree(out_blob.pbData as *mut c_void);
    }
    Ok(encoded)
}

/// Windows DPAPI CryptUnprotectData from base64 string
pub fn open_key(sealed: &str) -> Result<String, String> {
    if sealed.is_empty() {
        return Ok(String::new());
    }
    let decoded = BASE64_STANDARD.decode(sealed.trim()).map_err(|e| format!("Base64 decode error: {}", e))?;
    let mut in_bytes = decoded;
    let mut in_blob = DATA_BLOB {
        cbData: in_bytes.len() as u32,
        pbData: in_bytes.as_mut_ptr(),
    };
    let mut out_blob = DATA_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    let ok = unsafe {
        CryptUnprotectData(
            &mut in_blob,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
            &mut out_blob,
        )
    };

    if ok == 0 {
        return Err("CryptUnprotectData failed".to_string());
    }

    let decrypted_bytes = unsafe {
        std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize)
    };
    let plain = String::from_utf8(decrypted_bytes.to_vec()).map_err(|e| format!("UTF-8 error: {}", e))?;
    unsafe {
        LocalFree(out_blob.pbData as *mut c_void);
    }
    Ok(plain)
}
