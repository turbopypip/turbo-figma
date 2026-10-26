// Adapted to Rust from Node v20.12.2 deps/v8/src/base/ieee754.cc (atan/atan2).
// https://github.com/nodejs/node/blob/v20.12.2/deps/v8/src/base/ieee754.cc
// The following is adapted from fdlibm (http://www.netlib.org/fdlibm).
// ====================================================
// Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
// Developed at SunSoft, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this
// software is freely granted, provided that this notice
// is preserved.
// ====================================================
// The original source code covered by the above license has been
// modified significantly by Google Inc.
// Copyright 2016 the V8 project authors. All rights reserved.
// Keep operation order and avoid fused operations to preserve Node 20 output.
fn atan(mut x: f64) -> f64 {
    const HI: [u64; 4] = [
        0x3fddac670561bb4f,
        0x3fe921fb54442d18,
        0x3fef730bd281f69b,
        0x3ff921fb54442d18,
    ];
    const LO: [u64; 4] = [
        0x3c7a2b7f222f65e2,
        0x3c81a62633145c07,
        0x3c7007887af0cbbd,
        0x3c91a62633145c07,
    ];
    let a = [
        0x3fd555555555550d,
        0xbfc999999998ebc4,
        0x3fc24924920083ff,
        0xbfbc71c6fe231671,
        0x3fb745cdc54c206e,
        0xbfb3b0f2af749a6d,
        0x3fb10d66a0d03d51,
        0xbfadde2d52defd9a,
        0x3fa97b4b24760deb,
        0xbfa2b4442c6a6c2f,
        0x3f90ad3ae322da11,
    ]
    .map(f64::from_bits);
    let high = (x.to_bits() >> 32) as u32;
    let ix = high & 0x7fffffff;
    let negative = x.is_sign_negative();
    if ix >= 0x44100000 {
        if x.is_nan() {
            return x + x;
        }
        let v = f64::from_bits(HI[3]) + f64::from_bits(LO[3]);
        return if negative { -v } else { v };
    }
    let id;
    if ix < 0x3fdc0000 {
        if ix < 0x3e400000 {
            return x;
        }
        id = None;
    } else {
        x = x.abs();
        if ix < 0x3ff30000 {
            if ix < 0x3fe60000 {
                id = Some(0);
                x = (2. * x - 1.) / (2. + x);
            } else {
                id = Some(1);
                x = (x - 1.) / (x + 1.);
            }
        } else if ix < 0x40038000 {
            id = Some(2);
            x = (x - 1.5) / (1. + 1.5 * x);
        } else {
            id = Some(3);
            x = -1. / x;
        }
    }
    let z = x * x;
    let w = z * z;
    let s1 = z * (a[0] + w * (a[2] + w * (a[4] + w * (a[6] + w * (a[8] + w * a[10])))));
    let s2 = w * (a[1] + w * (a[3] + w * (a[5] + w * (a[7] + w * a[9]))));
    if let Some(id) = id {
        let z = f64::from_bits(HI[id]) - ((x * (s1 + s2) - f64::from_bits(LO[id])) - x);
        if negative {
            -z
        } else {
            z
        }
    } else {
        x - x * (s1 + s2)
    }
}
pub fn atan2(y: f64, x: f64) -> f64 {
    let pi = std::f64::consts::PI;
    let half = std::f64::consts::FRAC_PI_2;
    let low = f64::from_bits(0x3ca1a62633145c07);
    if x.is_nan() || y.is_nan() {
        return x + y;
    }
    if x == 1. {
        return atan(y);
    }
    let mut m = (y.is_sign_negative() as u8) | ((x.is_sign_negative() as u8) << 1);
    if y == 0. {
        return match m {
            0 | 1 => y,
            2 => pi,
            _ => -pi,
        };
    }
    if x == 0. {
        return if y.is_sign_negative() { -half } else { half };
    }
    if x.is_infinite() {
        return if y.is_infinite() {
            match m {
                0 => pi / 4.,
                1 => -pi / 4.,
                2 => 3. * (pi / 4.),
                _ => -3. * (pi / 4.),
            }
        } else {
            match m {
                0 => 0.,
                1 => -0.,
                2 => pi,
                _ => -pi,
            }
        };
    }
    if y.is_infinite() {
        return if y.is_sign_negative() { -half } else { half };
    }
    let ix = ((x.to_bits() >> 32) & 0x7fffffff) as i32;
    let iy = ((y.to_bits() >> 32) & 0x7fffffff) as i32;
    let k = (iy - ix) >> 20;
    let z = if k > 60 {
        m &= 1;
        half + 0.5 * low
    } else if x.is_sign_negative() && k < -60 {
        0.
    } else {
        atan((y / x).abs())
    };
    match m {
        0 => z,
        1 => -z,
        2 => pi - (z - low),
        _ => (z - low) - pi,
    }
}
