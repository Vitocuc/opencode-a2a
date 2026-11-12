# OpenCode

OpenCode is a coding agent that people and other programs work with through Sessions. This glossary covers the words for the protocols that let editors and other agents reach it.

## Agent protocols

**ACP (Agent Client Protocol)**:
The protocol an interactive client, such as an editor, uses to drive an agent's Session while a human stays in the loop.
_Avoid_: Using ACP for delegating to independent agents

**A2A (Agent2Agent)**:
The protocol for delegating an autonomous task to an independent agent, which may be remote, over an authenticated network connection. It is used to cross a boundary between agents, even when both run on the same machine.
_Avoid_: Agent-to-agent chat, ACP

**Subagent**:
A child Session of the same opencode server that an agent delegates part of its work to.
_Avoid_: Using A2A between Sessions of one opencode server

ACP and A2A sit at the same level and coexist. OpenCode can be driven by an editor over ACP and receive tasks from other agents over A2A at the same time.

## A2A roles

**Client agent**:
The agent that delegates a task over A2A in a given exchange. OpenCode is a client agent when it hands a task to another agent.
_Avoid_: Caller, peer, A2A client (when the agent is meant, not the software)

**Remote agent**:
The agent that receives and carries out a delegated task in a given exchange. OpenCode is a remote agent when another agent delegates to it; an opencode remote agent is one Location of an opencode server, advertised by its own Agent Card.
_Avoid_: Peer, A2A server (when the agent is meant, not the software)

Client agent and remote agent are roles in one exchange, not kinds of agent: the same agent can take either role.

**Agent Card**:
The public description a remote agent publishes so client agents know what it can do and how to reach it.
_Avoid_: Agent manifest, profile

**Card skill**:
An entry on an Agent Card naming one capability of the remote agent. On an opencode Agent Card, each card skill is one of opencode's Agents.
_Avoid_: Skill (on its own), which means an opencode Skill

**Skill**:
Loadable instructions an opencode Agent can use while working. Unrelated to card skills.
_Avoid_: Card skill
