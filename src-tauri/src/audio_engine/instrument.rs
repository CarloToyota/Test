//! Instrument table: transposition, clef, playable range and the DSP settings that
//! follow from the range (band-pass corners and analysis window length).

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum Instrument {
    Flute,
    Clarinet,
    AltoSax,
    TenorSax,
    BariSax,
    Trumpet,
    FrenchHorn,
    Trombone,
    Tuba,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Clef {
    Treble,
    Bass,
}

/// Static description of an instrument, also sent to the UI by `get_instruments`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstrumentInfo {
    pub id: Instrument,
    pub name: &'static str,
    /// The instrument's key: `"C"`, `"Bb"`, `"Eb"` or `"F"`.
    pub key: &'static str,
    /// Semitones added to concert pitch to get written pitch.
    pub transpose_semitones: i8,
    pub clef: Clef,
    /// Lowest and highest sounding MIDI notes the detector accepts (inclusive).
    pub concert_low: u8,
    pub concert_high: u8,
}

pub const ALL_INSTRUMENTS: [Instrument; 9] = [
    Instrument::Flute,
    Instrument::Clarinet,
    Instrument::AltoSax,
    Instrument::TenorSax,
    Instrument::BariSax,
    Instrument::Trumpet,
    Instrument::FrenchHorn,
    Instrument::Trombone,
    Instrument::Tuba,
];

/// The baseline analysis band from the design spec. Instruments whose range dips below
/// 70 Hz (bari sax, horn, trombone pedals, tuba) lower the high-pass so their bottom
/// octave is not attenuated away.
pub const DEFAULT_BAND_LOW_HZ: f32 = 70.0;
pub const DEFAULT_BAND_HIGH_HZ: f32 = 2200.0;

impl Instrument {
    pub fn info(self) -> InstrumentInfo {
        use Clef::*;
        use Instrument::*;
        // (name, key, transposition, clef, concert range). Ranges are the professional
        // range plus a little headroom, in sounding pitch.
        let (name, key, transpose_semitones, clef, concert_low, concert_high) = match self {
            Flute => ("Flute", "C", 0, Treble, 59, 98),              // B3 .. D7
            Clarinet => ("Bb Clarinet", "Bb", 2, Treble, 50, 94),    // D3 .. Bb6
            AltoSax => ("Eb Alto Sax", "Eb", 9, Treble, 49, 84),     // Db3 .. C6
            TenorSax => ("Bb Tenor Sax", "Bb", 14, Treble, 44, 79),  // Ab2 .. G5
            BariSax => ("Eb Bari Sax", "Eb", 21, Treble, 36, 72),    // C2 .. C5
            Trumpet => ("Bb Trumpet", "Bb", 2, Treble, 52, 86),      // E3 .. D6
            FrenchHorn => ("F French Horn", "F", 7, Treble, 34, 77), // Bb1 .. F5
            Trombone => ("Trombone", "C", 0, Bass, 34, 77),          // Bb1 (pedal) .. F5
            Tuba => ("Tuba", "C", 0, Bass, 26, 65),                  // D1 .. F4
        };
        InstrumentInfo {
            id: self,
            name,
            key,
            transpose_semitones,
            clef,
            concert_low,
            concert_high,
        }
    }

    /// Concert MIDI -> written MIDI for this instrument, clamped to the MIDI range.
    pub fn written_midi(self, concert_midi: u8) -> u8 {
        (concert_midi as i16 + self.info().transpose_semitones as i16).clamp(0, 127) as u8
    }

    /// Band-pass corners (Hz) for this instrument's range.
    pub fn band_hz(self) -> (f32, f32) {
        let info = self.info();
        let f_low = midi_to_hz(info.concert_low as f32);
        let f_high = midi_to_hz(info.concert_high as f32);
        // Keep the lowest fundamental at least ~1/3 octave above the high-pass corner.
        let low = DEFAULT_BAND_LOW_HZ.min(0.78 * f_low);
        // Keep four partials of the top note; above that only octave-error bait remains.
        let high = DEFAULT_BAND_HIGH_HZ.min((4.0 * f_high).max(800.0));
        (low, high)
    }

    /// McLeod analysis window: the next power of two holding at least 2.4 periods of the
    /// lowest note, clamped to 1024..=4096 samples.
    pub fn analysis_window(self, sample_rate: u32) -> usize {
        let f_low = midi_to_hz(self.info().concert_low as f32);
        let min_len = (2.4 * sample_rate as f32 / f_low).ceil() as usize;
        min_len.next_power_of_two().clamp(1024, 4096)
    }
}

pub fn midi_to_hz(midi: f32) -> f32 {
    440.0 * 2f32.powf((midi - 69.0) / 12.0)
}

pub fn hz_to_midi(hz: f32) -> f32 {
    69.0 + 12.0 * (hz / 440.0).log2()
}

const SHARP_NAMES: [&str; 12] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

/// Scientific pitch name using sharps, e.g. 61 -> `"C#4"`. The UI re-spells notes to fit
/// the key signature; this name is for logs and the live readout.
pub fn note_name(midi: u8) -> String {
    let octave = midi as i32 / 12 - 1;
    format!("{}{}", SHARP_NAMES[midi as usize % 12], octave)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transpositions_match_spec() {
        // Concert C4 = MIDI 60.
        assert_eq!(Instrument::Flute.written_midi(60), 60);
        assert_eq!(Instrument::Trumpet.written_midi(60), 62);
        assert_eq!(Instrument::Clarinet.written_midi(60), 62);
        assert_eq!(Instrument::TenorSax.written_midi(60), 74);
        assert_eq!(Instrument::AltoSax.written_midi(60), 69);
        assert_eq!(Instrument::BariSax.written_midi(60), 81);
        assert_eq!(Instrument::FrenchHorn.written_midi(60), 67);
        assert_eq!(Instrument::Trombone.written_midi(60), 60);
        assert_eq!(Instrument::Tuba.written_midi(60), 60);
    }

    #[test]
    fn clefs() {
        assert_eq!(Instrument::Trombone.info().clef, Clef::Bass);
        assert_eq!(Instrument::Tuba.info().clef, Clef::Bass);
        assert_eq!(Instrument::BariSax.info().clef, Clef::Treble);
    }

    #[test]
    fn dsp_settings_follow_range() {
        assert_eq!(Instrument::Flute.band_hz(), (70.0, 2200.0));
        let (tuba_low, tuba_high) = Instrument::Tuba.band_hz();
        assert!(tuba_low < 36.7 && tuba_high < 1500.0);
        assert_eq!(Instrument::Flute.analysis_window(48_000), 1024);
        assert_eq!(Instrument::TenorSax.analysis_window(48_000), 2048);
        assert_eq!(Instrument::Tuba.analysis_window(48_000), 4096);
    }

    #[test]
    fn names() {
        assert_eq!(note_name(60), "C4");
        assert_eq!(note_name(70), "A#4");
        assert_eq!(note_name(26), "D1");
    }
}
