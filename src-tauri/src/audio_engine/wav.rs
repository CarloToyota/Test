//! Minimal WAV encode/decode (no I/O): 16-bit mono export of a session, and reading
//! PCM 8/16/24/32-bit or 32/64-bit float files of any channel count for replay.

/// Encode mono samples (-1.0..=1.0) as 16-bit PCM WAV.
pub fn encode_wav_i16(samples: &[i16], sample_rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

pub fn f32_to_i16(x: f32) -> i16 {
    (x.clamp(-1.0, 1.0) * 32767.0).round() as i16
}

/// Decode a WAV file to mono f32 samples (channels averaged) and its sample rate.
pub fn decode_wav(bytes: &[u8]) -> Result<(Vec<f32>, u32), String> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a RIFF/WAVE file".into());
    }
    let u16_at = |i: usize| u16::from_le_bytes([bytes[i], bytes[i + 1]]);
    let u32_at = |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);

    let mut pos = 12;
    let mut fmt: Option<(u16, u16, u32, u16)> = None; // format, channels, rate, bits
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let len = u32_at(pos + 4) as usize;
        let body = pos + 8;
        let end = (body + len).min(bytes.len());
        if id == b"fmt " && len >= 16 {
            let mut format = u16_at(body);
            if format == 0xFFFE && len >= 26 {
                format = u16_at(body + 24); // WAVE_FORMAT_EXTENSIBLE sub-format
            }
            fmt = Some((format, u16_at(body + 2), u32_at(body + 4), u16_at(body + 14)));
        } else if id == b"data" {
            let (format, channels, rate, bits) = fmt.ok_or("data chunk before fmt chunk")?;
            let ch = channels.max(1) as usize;
            let width = (bits as usize).div_ceil(8);
            let data = &bytes[body..end];
            let frames = data.len() / (width * ch);
            let mut out = Vec::with_capacity(frames);
            for f in 0..frames {
                let mut sum = 0.0f32;
                for c in 0..ch {
                    let i = (f * ch + c) * width;
                    let b = &data[i..i + width];
                    sum += match (format, bits) {
                        (1, 8) => (b[0] as f32 - 128.0) / 128.0,
                        (1, 16) => i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0,
                        (1, 24) => (i32::from_le_bytes([0, b[0], b[1], b[2]]) >> 8) as f32 / 8_388_608.0,
                        (1, 32) => i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 / 2_147_483_648.0,
                        (3, 32) => f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
                        (3, 64) => f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]) as f32,
                        _ => return Err(format!("unsupported WAV encoding: format {format}, {bits} bits")),
                    };
                }
                out.push(sum / ch as f32);
            }
            return Ok((out, rate));
        }
        pos = body + len + (len & 1);
    }
    Err("no data chunk".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let samples: Vec<i16> = (0..1000).map(|i| ((i as f32 * 0.05).sin() * 20000.0) as i16).collect();
        let wav = encode_wav_i16(&samples, 44_100);
        let (decoded, rate) = decode_wav(&wav).unwrap();
        assert_eq!(rate, 44_100);
        assert_eq!(decoded.len(), samples.len());
        for (a, b) in decoded.iter().zip(&samples) {
            assert!((a - *b as f32 / 32768.0).abs() < 1e-6);
        }
    }
}
