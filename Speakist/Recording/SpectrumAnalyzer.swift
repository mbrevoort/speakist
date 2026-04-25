import Foundation
import Accelerate

/// Real-time FFT spectrum analyzer that converts each audio tap
/// buffer into per-band magnitudes for the HUD's voice waveform.
///
/// The HUD's bars represent log-spaced bands across the human voice
/// range (≈80 Hz – 4 kHz), so the leftmost bar reads the chest /
/// fundamental energy and the rightmost bar reads the formants /
/// sibilants. Tracking per-band lets the visualization "react" to
/// vowels vs consonants vs silence in a way an overall RMS meter
/// can't.
///
/// Operates on the recorder's already-converted 16 kHz mono Float32
/// stream — Nyquist is 8 kHz, well above the voice range, and the
/// FFT bin width at N=512 is 31.25 Hz which is ample resolution for
/// a 7-bar visualization.
///
/// Single-threaded: `analyze` runs on the audio tap callback which
/// always fires from the same Core Audio worker. Internal buffers
/// are preallocated and reused so each call avoids allocation.
final class SpectrumAnalyzer {
    private let n: Int
    private let halfN: Int
    private let log2n: vDSP_Length
    private let fftSetup: FFTSetup
    private let sampleRate: Float

    /// Hann window applied before FFT — clean spectrum, no rectangular
    /// leakage. Pre-baked at init since the window is constant.
    private var window: [Float]
    /// Sliding buffer of the last N samples seen across multiple tap
    /// callbacks. Most taps deliver fewer than N frames at our
    /// hardware-to-target ratio (48 → 16 kHz gives ~341 frames per
    /// 1024-frame tap), so we accumulate into a ring instead of
    /// trying to FFT each partial buffer in isolation.
    private var ring: [Float]
    /// Where the next sample lands in `ring`. Wraps modulo n.
    private var ringWriteIdx = 0
    /// True once the ring has wrapped at least once — before that we
    /// don't have enough history to FFT.
    private var ringFilled = false

    /// Working buffer — ring contents copied in chronological order
    /// before windowing + FFT. Same size as the ring; preallocated.
    private var ordered: [Float]
    /// Hann-windowed input — also preallocated.
    private var windowed: [Float]
    /// Split-complex real / imag arrays for the in-place FFT.
    private var realp: [Float]
    private var imagp: [Float]
    /// Power spectrum (|X|²) and amplitude (|X|) per FFT bin.
    private var magnitudesSquared: [Float]
    private var magnitudes: [Float]

    init(fftSize: Int = 512, sampleRate: Float = 16_000) {
        precondition(fftSize > 0 && (fftSize & (fftSize - 1)) == 0,
                     "fftSize must be a power of 2")
        self.n = fftSize
        self.halfN = fftSize / 2
        self.log2n = vDSP_Length(log2(Float(fftSize)))
        self.sampleRate = sampleRate
        self.fftSetup = vDSP_create_fftsetup(self.log2n, FFTRadix(kFFTRadix2))!

        self.window = [Float](repeating: 0, count: fftSize)
        vDSP_hann_window(&self.window, vDSP_Length(fftSize), Int32(vDSP_HANN_NORM))

        self.ring = [Float](repeating: 0, count: fftSize)
        self.ordered = [Float](repeating: 0, count: fftSize)
        self.windowed = [Float](repeating: 0, count: fftSize)
        self.realp = [Float](repeating: 0, count: fftSize / 2)
        self.imagp = [Float](repeating: 0, count: fftSize / 2)
        self.magnitudesSquared = [Float](repeating: 0, count: fftSize / 2)
        self.magnitudes = [Float](repeating: 0, count: fftSize / 2)
    }

    deinit {
        vDSP_destroy_fftsetup(fftSetup)
    }

    /// Feed `count` samples and return `bandCount` per-band
    /// magnitudes in [0, 1]. Returns nil before the ring has
    /// accumulated a full FFT window's worth of samples.
    ///
    /// The bands are log-spaced from 80 Hz to 4 kHz so the
    /// leftmost bar covers fundamentals + chest resonance and
    /// the rightmost covers high formants + sibilants. Each band's
    /// magnitude is the average of the FFT bins falling inside it.
    func analyze(input: UnsafePointer<Float>, frameCount: Int, bandCount: Int) -> [Float]? {
        // Append into the ring buffer.
        for i in 0..<frameCount {
            ring[ringWriteIdx] = input[i]
            ringWriteIdx += 1
            if ringWriteIdx >= n {
                ringWriteIdx = 0
                ringFilled = true
            }
        }
        guard ringFilled else { return nil }

        // Copy ring → ordered in chronological order. Two memcpys
        // (tail of ring then head) would be slightly faster but the
        // explicit loop reads better at the sizes we deal with.
        for i in 0..<n {
            ordered[i] = ring[(ringWriteIdx + i) % n]
        }

        // Apply Hann window.
        vDSP_vmul(ordered, 1, window, 1, &windowed, 1, vDSP_Length(n))

        // Pack interleaved real input into split-complex form for
        // the in-place real-FFT path. The Accelerate idiom: a real
        // signal of length N is treated as N/2 complex pairs and
        // converted with vDSP_ctoz.
        var split = DSPSplitComplex(realp: &realp, imagp: &imagp)
        windowed.withUnsafeBytes { raw in
            let complex = raw.baseAddress!.assumingMemoryBound(to: DSPComplex.self)
            vDSP_ctoz(complex, 2, &split, 1, vDSP_Length(halfN))
        }

        // Forward real FFT in place. Output is split-complex with
        // halfN bins covering 0…sampleRate/2.
        vDSP_fft_zrip(fftSetup, &split, 1, log2n, FFTDirection(FFT_FORWARD))

        // |X|² then sqrt for amplitude. Could skip the sqrt and
        // operate on power, but linear amplitude maps more
        // intuitively to "bar height".
        vDSP_zvmags(&split, 1, &magnitudesSquared, 1, vDSP_Length(halfN))
        var halfNInt = Int32(halfN)
        vvsqrtf(&magnitudes, magnitudesSquared, &halfNInt)

        // Aggregate FFT bins into log-spaced voice bands.
        let binWidth = sampleRate / Float(n)
        let lowFreq: Float = 80
        let highFreq: Float = 4_000
        let logLow = log(lowFreq)
        let logHigh = log(highFreq)

        var bands = [Float](repeating: 0, count: bandCount)
        for b in 0..<bandCount {
            let f1 = exp(logLow + Float(b) / Float(bandCount) * (logHigh - logLow))
            let f2 = exp(logLow + Float(b + 1) / Float(bandCount) * (logHigh - logLow))
            let bin1 = max(1, Int(f1 / binWidth))
            let bin2 = min(halfN, max(bin1 + 1, Int(f2 / binWidth)))
            var sum: Float = 0
            for bin in bin1..<bin2 {
                sum += magnitudes[bin]
            }
            bands[b] = sum / Float(max(1, bin2 - bin1))
        }

        // Empirical normalization — at our window length and
        // typical mic levels, normal voice peaks the per-band sum
        // around 4–8. 0.18 lifts normal speech to roughly 0.6–0.8
        // bar height after the controller's per-band smoother runs;
        // peaks clip cleanly thanks to the `min(1, …)`.
        let normalization: Float = 0.18
        return bands.map { min(1.0, max(0, $0 * normalization)) }
    }
}
