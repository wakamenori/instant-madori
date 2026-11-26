use crate::{JsonBody, apply::Operation, schema::Direction};
use schemars::JsonSchema;
use serde_json::json;

pub struct Tool {
    pub name: &'static str,
    pub input: JsonBody,
}

pub const ALL: &[Tool] = &[
    Tool {
        name: "edit_house",
        input: JsonBody::new::<EditHouse>("editHouseInputSchema"),
    },
    Tool {
        name: "read_house",
        input: JsonBody::new::<ReadHouse>("readHouseInputSchema"),
    },
    Tool {
        name: "finish",
        input: JsonBody::new::<Finish>("finishInputSchema"),
    },
];

/// Change the working single-storey house with an ordered batch of operations. Lengths are millimetres
/// on wall centre lines. Copy element ids exactly from earlier results or read_house. The batch is
/// atomic: the operations apply in order, and if one is rejected, none of them apply and the result
/// gives the zero-based index of the rejected operation and the reason. On success, the result lists
/// each operation's result and the inspection findings of the changed house. On an empty house, start
/// with place_rooms; other operations on an empty house are rejected with no_house.
#[derive(JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EditHouse {
    /// Applied in this order as one atomic batch.
    #[schemars(length(min = 1, max = 32))]
    pub operations: Vec<Operation>,
}

/// Read facts about the working house without changing it. Ask for the stored details of elements,
/// their measured dimensions, or the latest inspection findings. Use ids exactly as earlier results
/// returned them. Use it to find an id that an operation needs, or to check a change before you call
/// finish.
#[derive(JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReadHouse {
    pub query: ReadQuery,
}

#[derive(JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReadQuery {
    /// The stored details of the elements with these ids and the ids they refer to.
    Elements {
        #[schemars(length(min = 1, max = 32))]
        ids: Vec<ElementRef>,
    },
    /// The measured sizes of the elements with these ids, in millimetres and square metres.
    Dimensions {
        #[schemars(length(min = 1, max = 32))]
        ids: Vec<ElementRef>,
    },
    /// The inspection findings of the working house.
    Inspection {},
}

#[derive(JsonSchema)]
#[serde(transparent)]
pub struct ElementRef(
    #[schemars(length(min = 1, max = 64), regex(pattern = r"^[A-Za-z0-9._:-]+$"))] pub String,
);

/// End your turn with the answer the user reads: a new plan or a question. Call finish alone in its
/// turn, after you have seen the results of every edit; a finish call made together with other tools
/// is not accepted. A plan turns the working house into a new plan. If findings that block
/// confirmation remain, the result lists them; fix them with edit_house and call finish again. A
/// question adds no plan, and edits made since the last plan are discarded.
#[derive(JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Finish {
    pub answer: Answer,
}
#[derive(JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Answer {
    /// The working house becomes a new plan.
    Plan {
        /// Short name for the plan in the history list, from what changed. Write in Japanese for the
        /// user.
        #[schemars(length(min = 1, max = 40), regex(pattern = r"\S"))]
        name: String,
        /// What changed in this plan and why. Write in Japanese for the user.
        #[schemars(length(min = 1, max = 1000), regex(pattern = r"\S"))]
        explanation: String,
        /// Conditions you assumed because the request did not state them, one per item. Empty when
        /// none. Write in Japanese for the user.
        #[schemars(
            length(max = 5),
            inner(length(min = 1, max = 200), regex(pattern = r"\S"))
        )]
        assumptions: Vec<String>,
        /// Usability concerns that remain in this plan, one per item. Empty when none. Write in
        /// Japanese for the user.
        #[schemars(
            length(max = 5),
            inner(length(min = 1, max = 200), regex(pattern = r"\S"))
        )]
        concerns: Vec<String>,
    },
    /// Ask the user before changing the house further. No plan is added.
    Question {
        /// The question the user must answer before you can continue. Write in Japanese for the user.
        #[schemars(length(min = 1, max = 500), regex(pattern = r"\S"))]
        question: String,
        /// Answers the user can pick from. Write in Japanese for the user.
        #[schemars(
            length(min = 2, max = 6),
            inner(length(min = 1, max = 50), regex(pattern = r"\S"))
        )]
        choices: Vec<String>,
    },
}

pub fn render_tool_schemas() -> Result<String, String> {
    let mut tools = Vec::new();
    for tool in ALL {
        tools.push(json!({"name": tool.name, "input": (tool.input.generate)(Direction::Request)?}));
    }
    serde_json::to_string_pretty(&tools)
        .map(|s| s + "\n")
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ordered_tool_schemas_match_registry() -> Result<(), String> {
        let names: Vec<_> = ALL.iter().map(|tool| tool.name).collect();
        assert_eq!(names, ["edit_house", "read_house", "finish"]);
        assert_eq!(
            names.iter().collect::<std::collections::HashSet<_>>().len(),
            names.len()
        );
        for tool in ALL {
            let schema = (tool.input.generate)(Direction::Request)?;
            assert!(
                schema["description"]
                    .as_str()
                    .is_some_and(|s| !s.trim().is_empty())
            );
        }
        assert_eq!(
            render_tool_schemas()?,
            include_str!("../../../packages/contracts/src/generated/ai-tools.schema.json")
        );
        Ok(())
    }
}
