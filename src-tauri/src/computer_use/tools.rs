//! The computer-use tools a chat sees, and the exact arguments each one sends to the sidecar (WP-255).
//!
//! Ported from Up.computer (MIT, T3 Tools and Kirill Gurianov), `packages/computer-use-server/src/computerUse/`
//! `ComputerUseToolDefinitions.ts` and `ComputerUseBackendArgs.ts`. The sidecar is open-computer-use (MIT,
//! iFurySt/open-computer-use), whose own tool names these map to.
//!
//! Only the arguments listed here ever reach the sidecar: a field the model adds (a window id, a window placement, a
//! click method that moves the real pointer) is dropped, so it can never pick a target the policy didn't see.

use serde_json::{json, Map, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolMode {
    /// Reads only: a list of apps, or one app's window and text.
    Observe,
    /// Clicks, types, scrolls, drags or sets a value.
    Action,
}

pub struct ToolDef {
    pub name: &'static str,
    /// The sidecar's own tool name.
    pub backend: &'static str,
    pub description: &'static str,
    pub mode: ToolMode,
}

pub const TOOLS: &[ToolDef] = &[
    ToolDef {
        name: "computer_list_apps",
        backend: "list_apps",
        description: "List the apps open on the Mac, and ones used lately.",
        mode: ToolMode::Observe,
    },
    ToolDef {
        name: "computer_get_app_state",
        backend: "get_app_state",
        description: "Read one app's front window: a screenshot, its visible text and element indexes. Call it before acting on the app.",
        mode: ToolMode::Observe,
    },
    ToolDef {
        name: "computer_screenshot",
        backend: "get_app_state",
        description: "A screenshot of one app's front window.",
        mode: ToolMode::Observe,
    },
    ToolDef {
        name: "computer_click",
        backend: "click",
        description: "Click an element of an app by its index from computer_get_app_state, or by x/y in the latest screenshot when coordinates are allowed in Settings.",
        mode: ToolMode::Action,
    },
    ToolDef {
        name: "computer_secondary_action",
        backend: "perform_secondary_action",
        description: "Run a secondary accessibility action that computer_get_app_state listed for an element. For a context click use computer_click with button right.",
        mode: ToolMode::Action,
    },
    ToolDef {
        name: "computer_scroll",
        backend: "scroll",
        description: "Scroll an element of an app.",
        mode: ToolMode::Action,
    },
    ToolDef {
        name: "computer_drag",
        backend: "drag",
        description: "Drag between two points of an app's latest screenshot. Check the result in a new screenshot.",
        mode: ToolMode::Action,
    },
    ToolDef {
        name: "computer_type_text",
        backend: "type_text",
        description: "Type text into the app's focused element.",
        mode: ToolMode::Action,
    },
    ToolDef {
        name: "computer_press_key",
        backend: "press_key",
        description: "Press a key or a shortcut in an app.",
        mode: ToolMode::Action,
    },
    ToolDef {
        name: "computer_set_value",
        backend: "set_value",
        description: "Set the value of an app's element.",
        mode: ToolMode::Action,
    },
];

pub fn tool(name: &str) -> Option<&'static ToolDef> {
    TOOLS.iter().find(|tool| tool.name == name)
}

fn app_prop() -> Value {
    json!({ "type": "string", "description": "The app's visible name or bundle identifier." })
}

fn index_prop() -> Value {
    json!({ "type": "integer", "minimum": 0, "description": "Element index from computer_get_app_state." })
}

fn point_prop(axis: &str) -> Value {
    json!({ "type": "number", "description": format!("{axis} in pixels of the app's latest screenshot.") })
}

fn object(properties: Value, required: &[&str]) -> Value {
    let mut schema =
        json!({ "type": "object", "additionalProperties": false, "properties": properties });
    if !required.is_empty() {
        schema["required"] = json!(required);
    }
    schema
}

/// The input schema the chat sees for a tool.
pub fn input_schema(name: &str) -> Value {
    match name {
        "computer_list_apps" => object(json!({}), &[]),
        "computer_get_app_state" | "computer_screenshot" => {
            object(json!({ "app": app_prop() }), &["app"])
        }
        "computer_click" => object(
            json!({
                "app": app_prop(),
                "elementIndex": index_prop(),
                "x": point_prop("X"),
                "y": point_prop("Y"),
                "button": { "type": "string", "enum": ["left", "right", "middle"] },
                "double": { "type": "boolean" },
                "coordinateMethod": {
                    "type": "string",
                    "enum": ["app_post", "sky_click"],
                    "description": "For x/y only. app_post (the default) sends the click to the app; sky_click is for virtual machine and canvas windows (left button only)."
                }
            }),
            &["app"],
        ),
        "computer_secondary_action" => object(
            json!({
                "app": app_prop(),
                "elementIndex": index_prop(),
                "action": { "type": "string", "minLength": 1, "description": "The exact action name the element lists." }
            }),
            &["app", "elementIndex", "action"],
        ),
        "computer_scroll" => object(
            json!({
                "app": app_prop(),
                "elementIndex": index_prop(),
                "direction": { "type": "string", "enum": ["up", "down", "left", "right"] },
                "amount": { "type": "number", "exclusiveMinimum": 0, "description": "Pages to scroll; 1 when left out." }
            }),
            &["app", "elementIndex", "direction"],
        ),
        "computer_drag" => object(
            json!({
                "app": app_prop(),
                "fromX": point_prop("Start X"),
                "fromY": point_prop("Start Y"),
                "toX": point_prop("End X"),
                "toY": point_prop("End Y")
            }),
            &["app", "fromX", "fromY", "toX", "toY"],
        ),
        "computer_type_text" => object(
            json!({ "app": app_prop(), "text": { "type": "string", "minLength": 1 } }),
            &["app", "text"],
        ),
        "computer_press_key" => object(
            json!({
                "app": app_prop(),
                "key": { "type": "string", "minLength": 1 },
                "modifiers": { "type": "array", "items": { "type": "string", "enum": ["cmd", "ctrl", "alt", "shift"] } }
            }),
            &["app", "key"],
        ),
        "computer_set_value" => object(
            json!({ "app": app_prop(), "elementIndex": index_prop(), "value": { "type": "string" } }),
            &["app", "elementIndex", "value"],
        ),
        _ => object(json!({}), &[]),
    }
}

/// The tools as MCP lists them.
pub fn listed() -> Value {
    Value::Array(
        TOOLS
            .iter()
            .map(|tool| {
                let read_only = tool.mode == ToolMode::Observe;
                json!({
                    "name": tool.name,
                    "description": tool.description,
                    "inputSchema": input_schema(tool.name),
                    "annotations": { "readOnlyHint": read_only, "destructiveHint": !read_only, "openWorldHint": true }
                })
            })
            .collect(),
    )
}

fn string(args: &Map<String, Value>, key: &str) -> Result<String, String> {
    match args.get(key).and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() => Ok(value.to_string()),
        _ => Err(format!("Computer use needs a non-empty {key}.")),
    }
}

fn number(args: &Map<String, Value>, key: &str) -> Result<f64, String> {
    match args.get(key).and_then(Value::as_f64) {
        Some(value) if value.is_finite() => Ok(value),
        _ => Err(format!("Computer use needs a number for {key}.")),
    }
}

fn element_index(args: &Map<String, Value>) -> Result<String, String> {
    match args.get("elementIndex").and_then(Value::as_u64) {
        Some(index) if index <= (1u64 << 53) => Ok(index.to_string()),
        _ => Err("Computer use needs elementIndex as a whole number, 0 or more.".into()),
    }
}

fn key_alias(key: &str) -> &str {
    match key {
        "ArrowDown" => "Down",
        "ArrowLeft" => "Left",
        "ArrowRight" => "Right",
        "ArrowUp" => "Up",
        "Enter" => "Return",
        "Esc" => "Escape",
        other => other,
    }
}

fn modifier_alias(modifier: &str) -> Option<&'static str> {
    match modifier {
        "alt" => Some("alt"),
        "cmd" => Some("super"),
        "ctrl" => Some("ctrl"),
        "shift" => Some("shift"),
        _ => None,
    }
}

/// The sidecar's arguments for a call: only the supported fields, renamed to its names. Anything unknown is dropped
/// and anything malformed is refused, so no stray field can choose a different target.
pub fn backend_args(backend: &str, args: &Map<String, Value>) -> Result<Value, String> {
    if backend == "list_apps" {
        return Ok(json!({}));
    }
    let app = string(args, "app")?;
    match backend {
        // The sidecar always returns a screenshot of the app's key window; no window placement is ever passed.
        "get_app_state" => Ok(json!({ "app": app })),
        "click" => {
            let has_element = args.contains_key("elementIndex");
            let has_point = args.contains_key("x") || args.contains_key("y");
            if has_element == has_point {
                return Err(
                    "A click needs either elementIndex or both x and y, never both.".into(),
                );
            }
            let button = match args.get("button") {
                None => "left",
                Some(Value::String(b)) if matches!(b.as_str(), "left" | "right" | "middle") => {
                    b.as_str()
                }
                _ => return Err("That mouse button isn't supported.".into()),
            };
            let double = match args.get("double") {
                None => false,
                Some(Value::Bool(d)) => *d,
                _ => return Err("double must be true or false.".into()),
            };
            let mut out = json!({ "app": app, "mouse_button": button, "click_count": if double { 2 } else { 1 } });
            if has_element {
                if args.contains_key("coordinateMethod") {
                    return Err("coordinateMethod goes with x and y, not elementIndex.".into());
                }
                out["element_index"] = json!(element_index(args)?);
            } else {
                // Never the sidecar's "auto" or "global": auto may press a nearby button, global moves the real pointer.
                let method = match args.get("coordinateMethod") {
                    None => "app_post",
                    Some(Value::String(m)) if m == "app_post" || m == "sky_click" => m.as_str(),
                    _ => return Err("That click method isn't supported.".into()),
                };
                if method == "sky_click" && button != "left" {
                    return Err("sky_click only clicks the left button.".into());
                }
                out["x"] = json!(number(args, "x")?);
                out["y"] = json!(number(args, "y")?);
                out["click_method"] = json!(method);
            }
            Ok(out)
        }
        "type_text" => match args.get("text") {
            Some(Value::String(text)) if !text.is_empty() => {
                Ok(json!({ "app": app, "text": text }))
            }
            _ => Err("Typing needs some text.".into()),
        },
        "press_key" => {
            let raw = string(args, "key")?;
            let key = key_alias(&raw).to_string();
            let modifiers = match args.get("modifiers") {
                None => Vec::new(),
                Some(Value::Array(list)) => list
                    .iter()
                    .map(|m| m.as_str().and_then(modifier_alias))
                    .collect::<Option<Vec<_>>>()
                    .ok_or("Those keyboard modifiers aren't supported.")?,
                _ => return Err("Those keyboard modifiers aren't supported.".into()),
            };
            let key = if !modifiers.is_empty() && !key.contains('+') {
                let mut parts: Vec<String> = modifiers.iter().map(|m| m.to_string()).collect();
                parts.push(key);
                parts.join("+")
            } else {
                key
            };
            Ok(json!({ "app": app, "key": key }))
        }
        "perform_secondary_action" => Ok(json!({
            "app": app,
            "element_index": element_index(args)?,
            "action": string(args, "action")?,
        })),
        "set_value" => match args.get("value") {
            Some(Value::String(value)) => Ok(json!({
                "app": app,
                "element_index": element_index(args)?,
                "value": value,
            })),
            _ => Err("Setting a value needs a string value.".into()),
        },
        "scroll" => {
            let direction = string(args, "direction")?;
            if !matches!(direction.as_str(), "up" | "down" | "left" | "right") {
                return Err("Scroll up, down, left or right.".into());
            }
            let pages = if args.contains_key("amount") {
                number(args, "amount")?
            } else {
                1.0
            };
            if pages <= 0.0 {
                return Err("Scroll by more than 0 pages.".into());
            }
            Ok(json!({
                "app": app,
                "element_index": element_index(args)?,
                "direction": direction,
                "pages": pages,
            }))
        }
        "drag" => Ok(json!({
            "app": app,
            "from_x": number(args, "fromX")?,
            "from_y": number(args, "fromY")?,
            "to_x": number(args, "toX")?,
            "to_y": number(args, "toY")?,
        })),
        other => Err(format!("Computer use has no tool {other}.")),
    }
}

/// One line for the activity log. Typed text and set values are never written, only their length.
pub fn summarize(name: &str, args: &Map<String, Value>) -> String {
    let count = |key: &str| {
        args.get(key)
            .and_then(Value::as_str)
            .map(|s| s.chars().count())
            .unwrap_or(0)
    };
    let plural = |n: usize| if n == 1 { "" } else { "s" };
    match name {
        "computer_type_text" => {
            let n = count("text");
            return format!("type {n} character{}", plural(n));
        }
        "computer_set_value" => {
            let n = count("value");
            return format!("set a value ({n} character{})", plural(n));
        }
        "computer_press_key" => {
            if let Some(key) = args.get("key").and_then(Value::as_str) {
                // A key name, never typed text: cap it so nothing long lands in the log.
                return format!("press {}", key.chars().take(40).collect::<String>());
            }
        }
        _ => {}
    }
    let mut parts = Vec::new();
    if let Some(index) = args.get("elementIndex").and_then(Value::as_u64) {
        parts.push(format!("element {index}"));
    }
    if parts.is_empty() {
        name.trim_start_matches("computer_").replace('_', " ")
    } else {
        format!(
            "{} {}",
            name.trim_start_matches("computer_").replace('_', " "),
            parts.join(" ")
        )
    }
}

#[cfg(test)]
mod tests {
    // Cases ported from Up.computer's ComputerUseBackendArgs.test.ts (MIT).
    use super::*;

    fn args(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn every_tool_has_a_schema_and_unknown_fields_are_dropped() {
        for tool in TOOLS {
            assert_eq!(input_schema(tool.name)["additionalProperties"], false);
        }
        let out = backend_args(
            "get_app_state",
            &args(json!({ "app": "Notes", "window_placement": "agent_display", "windowId": 4 })),
        )
        .unwrap();
        assert_eq!(out, json!({ "app": "Notes" }));
        assert_eq!(
            backend_args("list_apps", &args(json!({ "app": "x" }))).unwrap(),
            json!({})
        );
    }

    #[test]
    fn clicks_take_an_element_or_a_point_never_both() {
        let element =
            backend_args("click", &args(json!({ "app": "Notes", "elementIndex": 3 }))).unwrap();
        assert_eq!(
            element,
            json!({ "app": "Notes", "mouse_button": "left", "click_count": 1, "element_index": "3" })
        );
        let point = backend_args(
            "click",
            &args(json!({ "app": "Notes", "x": 10, "y": 20, "double": true })),
        )
        .unwrap();
        assert_eq!(point["click_method"], "app_post");
        assert_eq!(point["click_count"], 2);
        for bad in [
            json!({ "app": "Notes" }),
            json!({ "app": "Notes", "elementIndex": 1, "x": 1, "y": 1 }),
            json!({ "app": "Notes", "elementIndex": -1 }),
            json!({ "app": "Notes", "elementIndex": 1.5 }),
            json!({ "app": "Notes", "elementIndex": 1, "coordinateMethod": "app_post" }),
            json!({ "app": "Notes", "x": 1, "y": 1, "coordinateMethod": "global" }),
            json!({ "app": "Notes", "x": 1, "y": 1, "coordinateMethod": "auto" }),
            json!({ "app": "Notes", "x": 1, "y": 1, "button": "right", "coordinateMethod": "sky_click" }),
            json!({ "app": "Notes", "elementIndex": 1, "button": "back" }),
            json!({ "elementIndex": 1 }),
            json!({ "app": "  ", "elementIndex": 1 }),
        ] {
            assert!(backend_args("click", &args(bad.clone())).is_err(), "{bad}");
        }
    }

    #[test]
    fn keys_scroll_drag_and_values_map_to_the_sidecar_names() {
        assert_eq!(
            backend_args(
                "press_key",
                &args(json!({ "app": "Notes", "key": "Enter", "modifiers": ["cmd", "shift"] }))
            )
            .unwrap()["key"],
            "super+shift+Return"
        );
        assert!(backend_args(
            "press_key",
            &args(json!({ "app": "Notes", "key": "a", "modifiers": ["hyper"] }))
        )
        .is_err());
        assert_eq!(
            backend_args(
                "scroll",
                &args(json!({ "app": "Notes", "elementIndex": 0, "direction": "down" }))
            )
            .unwrap()["pages"],
            1.0
        );
        assert!(backend_args(
            "scroll",
            &args(json!({ "app": "Notes", "elementIndex": 0, "direction": "sideways" }))
        )
        .is_err());
        assert!(backend_args(
            "scroll",
            &args(json!({ "app": "Notes", "elementIndex": 0, "direction": "up", "amount": 0 }))
        )
        .is_err());
        assert_eq!(
            backend_args(
                "drag",
                &args(json!({ "app": "Notes", "fromX": 1, "fromY": 2, "toX": 3, "toY": 4 }))
            )
            .unwrap(),
            json!({ "app": "Notes", "from_x": 1.0, "from_y": 2.0, "to_x": 3.0, "to_y": 4.0 })
        );
        assert!(backend_args("type_text", &args(json!({ "app": "Notes", "text": "" }))).is_err());
        assert!(backend_args(
            "set_value",
            &args(json!({ "app": "Notes", "elementIndex": 1 }))
        )
        .is_err());
        assert!(backend_args("select_text", &args(json!({ "app": "Notes" }))).is_err());
    }

    #[test]
    fn the_log_line_never_carries_typed_text() {
        let line = summarize(
            "computer_type_text",
            &args(json!({ "app": "Notes", "text": "hunter2" })),
        );
        assert_eq!(line, "type 7 characters");
        let line = summarize(
            "computer_set_value",
            &args(json!({ "app": "Notes", "elementIndex": 1, "value": "x" })),
        );
        assert_eq!(line, "set a value (1 character)");
        assert_eq!(
            summarize(
                "computer_click",
                &args(json!({ "app": "Notes", "elementIndex": 2 }))
            ),
            "click element 2"
        );
    }
}
