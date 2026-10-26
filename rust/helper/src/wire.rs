//! Bounded Kiwi interpreter. Limits and visitation mirror network-wire.ts.
use std::collections::{HashMap, HashSet};
use std::io::Write;
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
fn check(ok: bool, error: &'static str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(error.into())
    }
}
struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}
impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        check(n <= self.data.len() - self.pos, "Index out of bounds")?;
        let p = self.pos;
        self.pos += n;
        Ok(&self.data[p..self.pos])
    }
    fn byte(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn uint(&mut self) -> Result<u32> {
        let mut v = 0;
        for shift in (0..=28).step_by(7) {
            let b = self.byte()?;
            check(shift != 28 || b <= 15, "Invalid wire varint")?;
            v |= ((b & 127) as u32) << shift;
            if b & 128 == 0 {
                return Ok(v);
            }
        }
        Err("Invalid wire varint".into())
    }
    fn int(&mut self) -> Result<i32> {
        let n = self.uint()?;
        Ok(((n >> 1) as i32) ^ -((n & 1) as i32))
    }
    fn uint64(&mut self) -> Result<u64> {
        let mut v = 0;
        for shift in (0..=56).step_by(7) {
            let b = self.byte()?;
            if b & 128 == 0 || shift == 56 {
                return Ok(v | ((b as u64) << shift));
            }
            v |= ((b & 127) as u64) << shift;
        }
        unreachable!()
    }
    fn string(&mut self, keep: bool, limit: usize) -> Result<Option<String>> {
        let n = self.data[self.pos..]
            .iter()
            .position(|b| *b == 0)
            .ok_or("Unterminated wire string")?;
        check(n <= limit, "Wire string size limit exceeded")?;
        let b = self.take(n)?;
        self.take(1)?;
        // TextDecoder ignores a leading UTF-8 BOM, including in schema names.
        Ok(if keep {
            Some(
                std::str::from_utf8(b)?
                    .strip_prefix('\u{feff}')
                    .unwrap_or(std::str::from_utf8(b)?)
                    .to_owned(),
            )
        } else {
            None
        })
    }
}
#[derive(Debug)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    String(String),
    Array(Vec<Value>),
    Object(Vec<(String, Value)>),
}
impl Value {
    pub fn write(&self, w: &mut impl Write) -> Result<()> {
        match self {
            Self::Null => w.write_all(b"null")?,
            Self::Bool(v) => w.write_all(if *v { b"true" } else { b"false" })?,
            Self::Num(v) => {
                if v.is_finite() {
                    serde_json::to_writer(w, v)?;
                } else {
                    serde_json::to_writer(
                        w,
                        &serde_json::json!({"$kiwiFloat": if v.is_nan() {"NaN"} else if v.is_sign_positive() {"Infinity"} else {"-Infinity"}}),
                    )?;
                }
            }
            Self::String(v) => serde_json::to_writer(w, v)?,
            Self::Array(a) => {
                w.write_all(b"[")?;
                for (i, v) in a.iter().enumerate() {
                    if i > 0 {
                        w.write_all(b",")?;
                    }
                    v.write(w)?;
                }
                w.write_all(b"]")?;
            }
            Self::Object(a) => {
                w.write_all(b"{")?;
                for (i, (k, v)) in a.iter().enumerate() {
                    if i > 0 {
                        w.write_all(b",")?;
                    }
                    serde_json::to_writer(&mut *w, k)?;
                    w.write_all(b":")?;
                    v.write(w)?;
                }
                w.write_all(b"}")?;
            }
        }
        Ok(())
    }
}
#[derive(Clone)]
struct Field {
    name: String,
    ty: i32,
    array: bool,
    retain: bool,
}
struct Definition {
    name: String,
    kind: u8,
    fields: Vec<Field>,
    tags: HashMap<u32, usize>,
}
pub struct Decoder {
    defs: Vec<Definition>,
    message: usize,
}
fn valid(s: &str) -> bool {
    let mut b = s.bytes();
    b.next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
        && b.all(|c| c.is_ascii_alphanumeric() || c == b'_')
        && !["__proto__", "constructor", "prototype", "ByteBuffer"].contains(&s)
}
fn style(ty: &str, field: &str) -> bool {
    match ty {
        "VariableAnyValue" => [
            "alias",
            "boolValue",
            "textValue",
            "floatValue",
            "colorValue",
            "textDataValue",
            "symbolIdValue",
        ]
        .contains(&field),
        "DerivedTextData" => field == "fontMetaData",
        "TextData" => [
            "characters",
            "characterStyleIDs",
            "styleOverrideTable",
            "fontMetaData",
            "lines",
        ]
        .contains(&field),
        "FontMetaData" => ["key", "fontWeight", "fontStyle"].contains(&field),
        _ => true,
    }
}
impl Decoder {
    pub fn new(bytes: &[u8], fields: &HashSet<String>) -> Result<Self> {
        check(
            bytes.len() <= 2 * 1024 * 1024,
            "Wire schema size limit exceeded",
        )?;
        let mut r = Reader {
            data: bytes,
            pos: 0,
        };
        let count = r.uint()? as usize;
        check(count <= 2000, "Wire definition limit exceeded")?;
        let mut defs = Vec::<Definition>::new();
        let mut total = 0;
        for _ in 0..count {
            let name = r.string(true, 256)?.unwrap();
            let kind = r.byte()?;
            let n = r.uint()? as usize;
            total += n;
            check(
                valid(&name) && kind <= 2 && !defs.iter().any(|d| d.name == name) && total <= 20000,
                "Invalid wire schema or field limit",
            )?;
            let mut fs = Vec::new();
            let mut names = HashSet::new();
            let mut tags = HashMap::new();
            for j in 0..n {
                let field = r.string(true, 256)?.unwrap();
                let ty = r.int()?;
                let flags = r.byte()?;
                let tag = r.uint()?;
                check(
                    valid(&field)
                        && names.insert(field.clone())
                        && tags.insert(tag, j).is_none()
                        && flags <= 1
                        && (kind != 2 || tag != 0),
                    "Invalid wire schema field",
                )?;
                let retain = match name.as_str() {
                    "Message" => field == "type",
                    "UserChange" => false,
                    "NodeChange" => fields.contains(&field),
                    _ => style(&name, &field),
                };
                fs.push(Field {
                    name: field,
                    ty,
                    array: flags != 0,
                    retain,
                });
            }
            defs.push(Definition {
                name,
                kind,
                fields: fs,
                tags,
            });
        }
        check(r.pos == bytes.len(), "Trailing wire schema bytes")?;
        for d in &defs {
            if d.kind != 0 {
                for f in &d.fields {
                    check(
                        f.ty >= -8 && (f.ty < 0 || (f.ty as usize) < defs.len()),
                        "Invalid wire schema type",
                    )?;
                }
            }
        }
        // The reference resolves type IDs to names before dispatching primitives.
        // Valid schemas may define a type with the name of a primitive.
        let primitives = [
            "bool", "byte", "int", "uint", "float", "string", "int64", "uint64",
        ];
        let aliases: Vec<Option<i32>> = defs
            .iter()
            .map(|d| {
                primitives
                    .iter()
                    .position(|p| *p == d.name)
                    .map(|i| !(i as i32))
            })
            .collect();
        for d in &mut defs {
            if d.kind != 0 {
                for f in &mut d.fields {
                    if f.ty >= 0 {
                        if let Some(ty) = aliases[f.ty as usize] {
                            f.ty = ty;
                        }
                    }
                }
            }
        }
        let message = defs
            .iter()
            .position(|d| d.name == "Message")
            .ok_or("Required wire definitions missing")?;
        let node = defs
            .iter()
            .position(|d| d.name == "NodeChange")
            .ok_or("Required wire definitions missing")?;
        check(
            defs[message].kind == 2
                && defs[node].kind == 2
                && defs[message]
                    .fields
                    .iter()
                    .any(|f| f.name == "nodeChanges" && f.ty == node as i32 && f.array),
            "Required wire definitions missing",
        )?;
        Ok(Self { defs, message })
    }
    pub fn decode(
        &self,
        bytes: &[u8],
        visit: &mut impl FnMut(Value) -> Result<()>,
    ) -> Result<Value> {
        self.decode_mode(bytes, visit, false)
    }
    pub fn decode_strict(
        &self,
        bytes: &[u8],
        visit: &mut impl FnMut(Value) -> Result<()>,
    ) -> Result<Value> {
        self.decode_mode(bytes, visit, true)
    }
    fn decode_mode(
        &self,
        bytes: &[u8],
        visit: &mut impl FnMut(Value) -> Result<()>,
        strict: bool,
    ) -> Result<Value> {
        check(
            bytes.len() <= 64 * 1024 * 1024,
            "Wire frame size limit exceeded",
        )?;
        let mut state = State {
            decoder: self,
            strict,
            r: Reader {
                data: bytes,
                pos: 0,
            },
            operations: 0,
            node_start: 0,
            retained: 0,
            inside: false,
            visit,
        };
        let v = state.read(self.message as i32, true, 0)?;
        check(state.r.pos == bytes.len(), "Trailing wire message bytes")?;
        Ok(v)
    }
}
struct State<'a, 'b, F> {
    decoder: &'a Decoder,
    strict: bool,
    r: Reader<'b>,
    operations: usize,
    node_start: usize,
    retained: usize,
    inside: bool,
    visit: &'a mut F,
}
impl<F: FnMut(Value) -> Result<()>> State<'_, '_, F> {
    fn tick(&mut self) -> Result<()> {
        self.operations += 1;
        check(
            self.operations <= 32000000,
            "Wire message operation limit exceeded",
        )?;
        check(
            !self.inside || self.operations - self.node_start <= 100000,
            "Wire node operation limit exceeded",
        )
    }
    fn allocate(&mut self, n: usize) -> Result<()> {
        self.retained += n;
        check(
            self.retained <= 2 * 1024 * 1024,
            "Wire node allocation limit exceeded",
        )
    }
    fn read(&mut self, ty: i32, keep: bool, depth: usize) -> Result<Value> {
        self.tick()?;
        if self.inside && keep {
            self.allocate(32)?;
        }
        check(depth <= 64, "Wire nesting limit exceeded")?;
        let primitive = match ty {
            -1 => Some(Value::Bool(self.r.byte()? != 0)),
            -2 => Some(Value::Num(self.r.byte()? as f64)),
            -3 => Some(Value::Num(self.r.int()? as f64)),
            -4 => Some(Value::Num(self.r.uint()? as f64)),
            -5 => {
                let b = self.r.byte()?;
                let n = if b == 0 {
                    0.0
                } else {
                    let rest = self.r.take(3)?;
                    f32::from_bits(
                        u32::from_le_bytes([b, rest[0], rest[1], rest[2]]).rotate_right(9),
                    ) as f64
                };
                check(!self.strict || n.is_finite(), "Nonfinite live value")?;
                Some(Value::Num(n))
            }
            -6 => {
                let start = self.r.pos;
                let limit = if self.inside && keep {
                    ((2 * 1024 * 1024 - self.retained) / 2).min(1024 * 1024)
                } else {
                    1024 * 1024
                };
                let s = self.r.string(keep, limit)?;
                if self.inside && keep {
                    self.retained += (self.r.pos - start) * 2;
                }
                Some(s.map(Value::String).unwrap_or(Value::Null))
            }
            -7 | -8 => {
                let v = self.r.uint64()?;
                Some(if keep {
                    Value::String(if ty == -7 {
                        (((v >> 1) as i64) ^ -((v & 1) as i64)).to_string()
                    } else {
                        v.to_string()
                    })
                } else {
                    Value::Null
                })
            }
            _ => None,
        };
        if let Some(v) = primitive {
            return Ok(if keep { v } else { Value::Null });
        }
        let d = &self.decoder.defs[ty as usize];
        if d.kind == 0 {
            let tag = self.r.uint()?;
            let f = d.tags.get(&tag).ok_or("Unknown wire enum value")?;
            return Ok(if keep {
                Value::String(d.fields[*f].name.clone())
            } else {
                Value::Null
            });
        }
        let mut result = Vec::new();
        let mut seen = [0_u64; 4];
        let mut extra_seen = HashSet::new();
        let mut index = 0;
        loop {
            let f = if d.kind == 1 {
                if index == d.fields.len() {
                    break;
                }
                let f = &d.fields[index];
                index += 1;
                f
            } else {
                let tag = self.r.uint()?;
                if tag == 0 {
                    break;
                }
                let field_index = *d.tags.get(&tag).ok_or("Unknown wire field")?;
                let unique = if field_index < 256 {
                    let slot = &mut seen[field_index / 64];
                    let mask = 1_u64 << (field_index % 64);
                    let unique = *slot & mask == 0;
                    *slot |= mask;
                    unique
                } else {
                    extra_seen.insert(field_index)
                };
                check(unique, "Duplicate wire field")?;
                &d.fields[field_index]
            };
            self.tick()?;
            let stream = depth == 0 && d.name == "Message" && f.name == "nodeChanges";
            let retain = keep && f.retain;
            if self.strict {
                check(
                    !(d.name == "Message" && f.name != "type" && f.name != "nodeChanges")
                        && !(d.name == "NodeChange" && !f.retain),
                    "Unsupported live wire field",
                )?;
                check(!keep || retain || stream, "Unsupported nested live field")?;
            }
            let value = if !f.array {
                self.read(f.ty, retain, depth + 1)?
            } else {
                let n = self.r.uint()? as usize;
                check(
                    n <= if f.ty == -2 { 64 * 1024 * 1024 } else { 200000 }
                        && (!retain || n <= 10000),
                    "Wire array limit exceeded",
                )?;
                if f.ty == -2 {
                    let b = self.r.take(n)?;
                    if retain {
                        if self.inside {
                            self.allocate(n * 8)?;
                        }
                        Value::Array(b.iter().map(|v| Value::Num(*v as f64)).collect())
                    } else {
                        Value::Null
                    }
                } else {
                    let mut a = Vec::new();
                    for _ in 0..n {
                        if stream {
                            self.node_start = self.operations;
                            self.retained = 0;
                            self.inside = true;
                        }
                        let v = self.read(f.ty, retain || stream, depth + 1)?;
                        if stream {
                            self.inside = false;
                            (self.visit)(v)?;
                        } else if retain {
                            a.push(v);
                        }
                    }
                    if retain {
                        Value::Array(a)
                    } else {
                        Value::Null
                    }
                }
            };
            if retain {
                result.push((f.name.clone(), value));
            }
        }
        Ok(if keep {
            Value::Object(result)
        } else {
            Value::Null
        })
    }
}
