// Conformance harness (docs/CONFORMANCE.md): runs cases against the root API of generated code.
//
//   harness <cases.json> <results.jsonl> [skip]
//
// cases.json is an array of normalized cases (hex bytes or { "file": "<absolute path>" }). Each
// result is written as one JSON line as soon as it is known, so a crash loses only one case (the
// adapter restarts the harness after it with `skip`).
#pragma once

#include <cstdio>
#include <fstream>
#include <iostream>
#include <sstream>

#include "yaffle.hpp"

namespace yaffle::harness {

struct RootOps {
  std::string name;
  std::function<std::shared_ptr<void>(BytesView, const Json& args, bool strict)> parse;
  std::function<Bytes(const void* value, const Json& args, bool strict)> serialize;
  std::function<Json(const void* value)> to_json;
  std::function<std::shared_ptr<void>(const Json&)> from_json;
  /// View mode (docs/CONFORMANCE.md §7): opens a view, materializes every field through it into
  /// `json`, and returns the bytes of committing it with no edits. Empty without views.
  std::function<Bytes(BytesView, const Json& args, bool strict, Json& json)> view;
};

/// Type-erased root API of a generated root struct `T`.
template <class T>
RootOps root(const char* name) {
  using V = typename T::Value;
  RootOps ops;
  ops.name = name;
  ops.parse = [](BytesView b, const Json& args, bool strict) -> std::shared_ptr<void> {
    auto o = T::options_from_json(args);
    if (strict) o.strict = true;
    return std::make_shared<V>(T::parse(b, o));
  };
  ops.serialize = [](const void* v, const Json& args, bool strict) -> Bytes {
    auto o = T::options_from_json(args);
    if (strict) o.strict = true;
    return T::serialize(*static_cast<const V*>(v), o);
  };
  ops.to_json = [](const void* v) -> Json { return T::to_json(*static_cast<const V*>(v)); };
  ops.from_json = [](const Json& j) -> std::shared_ptr<void> { return std::make_shared<V>(T::from_json(j)); };
  if constexpr (requires { typename T::View; }) {
    ops.view = [](BytesView b, const Json& args, bool strict, Json& json) -> Bytes {
      auto o = T::options_from_json(args);
      if (strict) o.strict = true;
      auto v = T::view(Bytes(b.begin(), b.end()), o);
      json = T::to_json(v.materialize());
      return v.commit();
    };
  }
  return ops;
}

inline std::string read_file(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f) throw std::runtime_error("cannot open " + path);
  std::ostringstream ss;
  ss << f.rdbuf();
  return ss.str();
}

inline bool not_implemented(const std::string& msg) {
  return msg.find("not implemented") != std::string::npos || msg.find("not supported") != std::string::npos;
}

inline Json error_json(const Error& e, const char* phase) {
  Json err = Json::object();
  err.set("phase", phase);
  err.set("code", code_name(e.code));
  Json path = Json::array();
  for (const auto& s : e.path) {
    if (s.is_index())
      path.push(Json(static_cast<double>(s.index)));
    else
      path.push(Json(s.name));
  }
  err.set("path", std::move(path));
  err.set("offset", Json(static_cast<double>(e.offset)));
  err.set("message", e.what());
  return err;
}

/// Byte outputs larger than this are left out of results (large sample files).
inline constexpr std::size_t kMaxHexBytes = 1 << 20;

/// One case being run: what it expects, and the result built so far.
class CaseRun {
 public:
  CaseRun(const RootOps& ops, const Json& c, const Json& name) : ops_(ops), c_(c) {
    result_.set("name", name);
    result_.set("ok", false);
    static const Json null_json;
    const Json* args = c.find("args");
    args_ = args ? args : &null_json;
    const Json* strict = c.find("strict");
    strict_ = strict && strict->is_bool() && strict->as_bool();
    error_ = c.find("error");
    if (error_)
      if (const Json* p = error_->find("phase"); p && p->is_string()) error_phase_ = p->as_string();
    if (const Json* b = c.find("bytes")) {
      if (b->is_string())
        bytes_ = from_hex(b->as_string());
      else if (const Json* f = b->find("file")) {
        std::string data = read_file(f->as_string());
        bytes_ = Bytes(data.begin(), data.end());
      }
    }
    expected_json_ = c.find("json");
  }

  /// Runs the case; `result()` holds the outcome.
  void run() {
    const Json* input = c_.find("input");
    phase_ = input ? "serialize" : "parse";
    const Json* mode = c_.find("mode");
    try {
      if (input)
        serialize_case(*input);
      else if (!bytes_)
        finish(false, "parse case without bytes");
      else if (mode && mode->is_string() && mode->as_string() == "view")
        view_case();
      else
        parse_case();
    } catch (const Error& e) {
      result_.set("error", error_json(e, phase_));
      if (!error_) {
        if (not_implemented(e.what()))
          skip(e.what());
        else
          finish(false, std::string("unexpected error: ") + e.what());
        return;
      }
      const Json* code = error_->find("code");
      bool ok = error_phase_ == phase_ && code && code->is_string() && code->as_string() == code_name(e.code);
      finish(ok, ok ? "" : std::string("unexpected error: ") + e.what());
    } catch (const std::exception& e) {
      if (not_implemented(e.what()))
        skip(e.what());
      else
        finish(false, std::string("unexpected exception: ") + e.what());
    }
  }

  Json& result() { return result_; }

 private:
  const RootOps& ops_;
  const Json& c_;
  const Json* args_;
  bool strict_;
  const Json* error_;
  std::string error_phase_;
  std::optional<Bytes> bytes_;
  const Json* expected_json_;
  const char* phase_ = "parse";
  Json result_ = Json::object();

  void finish(bool ok, const std::string& message) {
    result_.set("ok", ok);
    if (!message.empty()) result_.set("message", message);
  }
  void skip(const std::string& why) {
    result_.set("skipped", why);
    finish(false, "");
  }
  void set_bytes(const Bytes& out) {
    if (out.size() <= kMaxHexBytes) result_.set("bytes", to_hex(out));
  }

  /// `from_json(input)` serialized must give the case's bytes.
  void serialize_case(const Json& input) {
    auto v = ops_.from_json(input);
    Bytes out = ops_.serialize(v.get(), *args_, strict_);
    set_bytes(out);
    if (error_) return finish(false, "expected an error, but serialize succeeded");
    if (!bytes_) return finish(false, "serialize case without bytes");
    if (out != *bytes_) return finish(false, "serialize: bytes differ");
    finish(true, "");
  }

  /// View mode (docs/CONFORMANCE.md §7): the JSON materialized through a view, and the bytes of
  /// committing it unedited.
  void view_case() {
    if (!ops_.view) return finish(false, "not implemented: views are not generated");
    Json json;
    Bytes out = ops_.view(BytesView(*bytes_), *args_, strict_, json);
    result_.set("json", json);
    if (error_phase_ == "parse") return finish(false, "expected a parse error, but the view read succeeded");
    const Json* rt = c_.find("roundtrip");
    if (!(rt && rt->is_bool() && !rt->as_bool())) {
      set_bytes(out);
      if (out != *bytes_) return finish(false, "view commit: bytes differ");
    }
    if (expected_json_ && !(*expected_json_ == json)) return finish(false, "view: JSON differs");
    finish(true, "");
  }

  /// Parse, compare the JSON, and serialize again (from the JSON or the value) per `roundtrip`.
  void parse_case() {
    auto v = ops_.parse(BytesView(*bytes_), *args_, strict_);
    Json json = ops_.to_json(v.get());
    if (error_phase_ == "parse") {
      result_.set("json", std::move(json));
      return finish(false, "expected a parse error, but parse succeeded");
    }
    bool json_ok = !expected_json_ || *expected_json_ == json;
    std::string rt = roundtrip_mode();
    if (rt != "false") {
      phase_ = "serialize";
      std::shared_ptr<void> in = rt == "value" ? v : ops_.from_json(expected_json_ ? *expected_json_ : json);
      Bytes out = ops_.serialize(in.get(), *args_, strict_);
      set_bytes(out);
      result_.set("json", std::move(json));
      if (error_) return finish(false, "expected a serialize error, but serialize succeeded");
      if (out != *bytes_) return finish(false, bytes_differ(out));
    } else {
      result_.set("json", std::move(json));
    }
    if (!json_ok) return finish(false, "parse: JSON differs");
    finish(true, "");
  }

  /// `roundtrip`: "json" (default), "value" or "false"; an expected serialize error needs one.
  std::string roundtrip_mode() const {
    if (error_phase_ == "serialize") return "json";
    const Json* rt = c_.find("roundtrip");
    if (rt && rt->is_bool()) return rt->as_bool() ? "json" : "false";
    if (rt && rt->is_string()) return rt->as_string();
    return "json";
  }

  std::string bytes_differ(const Bytes& out) const {
    const Bytes& want = *bytes_;
    std::size_t i = 0;
    while (i < out.size() && i < want.size() && out[i] == want[i]) i++;
    char buf[160];
    std::snprintf(buf, sizeof buf, "roundtrip: bytes differ at offset 0x%zx (expected %zu bytes, got %zu)", i,
                  want.size(), out.size());
    return buf;
  }
};

inline Json run_case(const std::vector<RootOps>& roots, const Json& c) {
  const Json* name = c.find("name");
  const Json* root = c.find("root");
  for (const auto& r : roots) {
    if (!root || !root->is_string() || r.name != root->as_string()) continue;
    CaseRun run(r, c, name ? *name : Json(""));
    run.run();
    return std::move(run.result());
  }
  Json result = Json::object();
  result.set("name", name ? *name : Json(""));
  result.set("ok", false);
  result.set("message", "unknown root");
  return result;
}

inline int run(const std::vector<RootOps>& roots, int argc, char** argv) {
  if (argc < 3) {
    std::fprintf(stderr, "usage: %s <cases.json> <results.jsonl> [skip]\n", argv[0]);
    return 2;
  }
  Json cases = Json::parse(read_file(argv[1]));
  std::size_t skip = argc > 3 ? static_cast<std::size_t>(std::stoull(argv[3])) : 0;
  std::FILE* out = std::fopen(argv[2], skip ? "ab" : "wb");
  if (!out) {
    std::fprintf(stderr, "cannot write %s\n", argv[2]);
    return 2;
  }
  const auto& list = cases.as_array();
  for (std::size_t i = skip; i < list.size(); i++) {
    Json r = run_case(roots, list[i]);
    std::string line = r.dump();
    line += '\n';
    std::fwrite(line.data(), 1, line.size(), out);
    std::fflush(out);
  }
  std::fclose(out);
  return 0;
}

}  // namespace yaffle::harness
