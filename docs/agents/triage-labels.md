# Triage labels

Map the five canonical triage roles directly to GitHub labels:

| Role              | Label             | State                            |
| ----------------- | ----------------- | -------------------------------- |
| `needs-triage`    | `needs-triage`    | Maintainer evaluation is pending |
| `needs-info`      | `needs-info`      | Reporter information is pending  |
| `ready-for-agent` | `ready-for-agent` | An agent can implement the issue |
| `ready-for-human` | `ready-for-human` | Human implementation is required |
| `wontfix`         | `wontfix`         | The issue will not be actioned   |

Use the mapped label whenever a skill names its canonical role, so workflow language stays
stable if repository label strings change later.
