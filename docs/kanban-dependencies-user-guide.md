# Kanban Dependencies User Guide

**Learn how to create and manage task dependencies in your EClaw kanban board**

## What are Dependencies?

Dependencies let you connect related tasks so they work together in the right order. When Task A depends on Task B, Task A can't start until Task B is finished.

### Why Use Dependencies?
- **Ensure correct order**: Critical tasks complete before dependent work starts
- **Visual clarity**: See how your project tasks connect together  
- **Automatic updates**: Card statuses update automatically as dependencies resolve
- **Prevent conflicts**: System prevents circular dependencies that would block progress

---

## Getting Started

### 1. Understanding Dependency Types

**🚫 Blocks (Default)**
- The most common type
- Target task MUST complete before dependent task can proceed
- Example: "Deploy to Production" blocks on "Pass All Tests"

**📋 Subtask**  
- Shows parent-child relationships
- Informational only (no blocking)
- Example: "Write Unit Tests" is subtask of "Implement Login Feature"

**🔗 Related**
- Shows loose connections between tasks  
- No blocking behavior
- Example: "Update Documentation" related to "Add New Feature"

### 2. Card Dependency Status

Your cards will show one of these dependency statuses:

| Status | Meaning | What You See |
|--------|---------|-------------|  
| **Ready** 🟢 | No blocking dependencies | Card can be worked on |
| **Waiting** 🟡 | Has incomplete dependencies | Card is blocked |
| **Blocked** 🔴 | Manually blocked by user | Overrides dependency status |

---

## Creating Dependencies

### Method 1: Drag and Drop (Recommended)

1. **Open Dependency Manager**
   - Click the "Dependencies" tab on any kanban card
   - Or use the dependency icon (🔗) in the card toolbar

2. **Drag to Connect**
   - Drag the source card onto the target card
   - Source = the card that will depend on the target
   - Target = the card that must complete first

3. **Confirm Connection**
   - System validates the dependency (checks for cycles)
   - Dependency appears in both cards' dependency lists
   - Card statuses update automatically

![Drag and Drop Example](images/drag-drop-dependency.png)

### Method 2: Manual Selection

1. **Select Source Card**
   - Open the card that should depend on another
   - Go to "Dependencies" tab

2. **Choose Target**
   - Click "Add Dependency" 
   - Select the card to depend on from dropdown
   - Choose dependency type if needed

3. **Save**
   - Click "Create Dependency"
   - System validates and creates the connection

### What Happens After Creating

✅ **Immediate Updates:**
- Both cards show the new dependency relationship
- Source card status may change to "Waiting" if target isn't done
- Dependency graph updates in real-time

✅ **Automatic Status Management:**
- When target card moves to "Done", source card becomes "Ready"
- Visual indicators show dependency status throughout the board

---

## Managing Dependencies

### Viewing Dependencies

**In Card Details:**
- "Depends On" section shows what this card waits for
- "Dependents" section shows what waits for this card
- Summary counts give you a quick overview

**In Dependency Graph:**
- Visual network showing all connected cards
- Color coding by status (green=ready, yellow=waiting, red=blocked)
- Hierarchical layout makes chains easy to follow

### Removing Dependencies

1. **Open Either Card**
   - Source or target card both work

2. **Find Dependency**
   - Look in "Dependencies" tab
   - Find the connection you want to remove

3. **Delete**
   - Click the "×" or "Remove" button next to the dependency
   - Confirm deletion
   - Both cards update immediately

### Editing Dependencies

**Change Dependency Type:**
1. Remove the existing dependency
2. Create a new one with the correct type

**Update Target:**
1. Remove the current dependency  
2. Create new dependency to different target

---

## Working with Dependency Chains

### Simple Chain
```
Task A → Task B → Task C
```
- A must complete before B can start
- B must complete before C can start
- Linear workflow, one task at a time

### Parallel Dependencies
```
Task A ↘
         → Task C
Task B ↗
```
- Both A and B must complete before C can start
- A and B can work in parallel
- Good for gathering multiple inputs

### Complex Networks
```
Task A → Task C → Task E
Task B → Task D → Task F
      ↘       ↗
        Task G
```
- Multiple parallel tracks with convergence points
- Requires careful planning to avoid bottlenecks

---

## Cycle Detection & Prevention

### What is a Cycle?

A cycle occurs when dependencies form a loop:
```
❌ Task A → Task B → Task C → Task A
```

This creates a deadlock where no task can ever start.

### How EClaw Prevents Cycles

**Real-Time Validation:**
- Every dependency is checked before creation
- If adding would create a cycle, the system blocks it
- Clear error message explains the issue

**Warning Examples:**
- "This dependency would create a cycle"
- "Card A already depends on Card B through Card C"

### Resolving Cycle Errors

1. **Review the Chain**
   - Trace the dependency path between cards
   - Look for the circular connection

2. **Choose the Right Direction**
   - Decide which task should really come first
   - Remove incorrect dependencies

3. **Restructure if Needed**
   - Break large tasks into smaller pieces
   - Create parallel tracks instead of circular ones

---

## Best Practices

### ✅ Do's

**Start Simple**
- Begin with obvious sequential dependencies
- Add complexity gradually as you understand the system

**Use Clear Naming**
- Make card titles specific and actionable
- Good: "Deploy user authentication API" 
- Bad: "Work on login stuff"

**Regular Review**
- Check dependency graph weekly
- Remove dependencies that are no longer needed
- Adjust as project requirements change

**Plan Parallel Work**
- Identify tasks that can run simultaneously
- Use parallel dependencies to maximize team efficiency

### ❌ Don'ts

**Don't Over-Depend**
- Not every task relationship needs a formal dependency
- Only create dependencies for true blocking relationships

**Don't Create Cycles**
- Always think through the logical flow before adding
- Use validation endpoint for complex scenarios

**Don't Ignore Warnings**
- Cycle detection exists for good reasons
- Address cycle warnings rather than working around them

**Don't Forget to Clean Up**
- Remove dependencies when they're no longer needed
- Outdated dependencies create confusion

---

## Common Workflows

### Project Kickoff
1. **Create Epic Cards** for major features
2. **Break Down into Tasks** with subtask dependencies  
3. **Identify Prerequisites** and add blocking dependencies
4. **Review Graph** to spot potential bottlenecks
5. **Assign Work** following dependency order

### Sprint Planning
1. **Check Ready Cards** (no blocking dependencies)
2. **Prioritize by Dependencies** (unblock others first)
3. **Plan Parallel Work** where possible
4. **Monitor Progress** through dependency dashboard

### Bug Fixing
1. **Create Investigation Card** as foundation
2. **Add Fix Cards** that depend on investigation
3. **Add Testing Cards** that depend on fixes
4. **Chain to Deployment** if needed

### Feature Development
1. **Design Card** as root dependency
2. **Implementation Cards** depend on design
3. **Testing Cards** depend on implementation
4. **Documentation Cards** can run in parallel
5. **Release Card** depends on all above

---

## Troubleshooting

### "My card status isn't updating"

**Check:**
- Are all dependencies actually marked "Done"?
- Is there a manual block on the card?
- Refresh the page to see latest updates

**Fix:**
- Complete or remove blocking dependencies
- Remove manual blocks if appropriate
- Contact admin if status seems stuck

### "I can't create a dependency"

**Common Causes:**
- Would create a cycle (check dependency path)
- Cards are in different projects/devices
- You don't have permission to edit one of the cards

**Fix:**
- Use validation endpoint to check for cycles
- Verify card ownership and permissions
- Check that both cards exist and are active

### "Dependencies aren't showing in graph"

**Check:**
- Are you in the right project/device scope?
- Are the cards archived or deleted?
- Try refreshing the dependency graph view

**Fix:**
- Verify card status and scope
- Clear browser cache if needed
- Check that dependencies were actually created

### "Performance is slow with many dependencies"

**Optimization:**
- Use subgraph view instead of full graph
- Archive completed cards periodically
- Contact admin about database optimization

---

## Keyboard Shortcuts

When in dependency manager:

| Shortcut | Action |
|----------|--------|
| `D` | Open dependency manager |
| `A` | Add new dependency |
| `G` | Show dependency graph |
| `V` | Validate potential dependency |
| `Esc` | Close dependency panels |
| `Tab` | Navigate between cards |
| `Enter` | Confirm dependency creation |

---

## Mobile Usage

### Creating Dependencies on Mobile

**Touch and Hold:**
- Long press on source card
- Drag to target card
- Release to create dependency

**Menu Method:**
- Tap card to open details
- Tap "Dependencies" tab
- Use "Add Dependency" button
- Select target from list

### Viewing Dependencies on Mobile

**Card View:**
- Dependency count shown as badge
- Tap to expand dependency list
- Swipe to see related cards

**Graph View:**
- Pinch to zoom dependency graph
- Double-tap card to see details
- Use two-finger scroll to navigate

---

## Tips & Tricks

### 🎯 Power User Tips

**Batch Operations:**
- Select multiple cards and create dependencies in bulk
- Use project templates with pre-defined dependency patterns

**Custom Views:**
- Filter kanban board by dependency status
- Create saved views for "Ready to Work" cards
- Use dependency depth to prioritize work

**Integration:**
- Link dependencies to external project management tools
- Use API to sync dependencies with other systems
- Export dependency data for reporting

### 🚀 Advanced Features

**Conditional Dependencies:**
- Set up dependencies that activate based on card status
- Use custom fields to create complex dependency rules

**Dependency Templates:**
- Save common dependency patterns
- Apply templates to new projects
- Share templates across teams

**Analytics:**
- Track average time to resolve dependencies
- Identify frequently blocking cards
- Monitor dependency complexity trends

---

## Getting Help

### Documentation
- [API Reference](kanban-dependencies-api.md) - For developers
- [Technical Specification](kanban-dependencies-spec.md) - System details

### Support Channels
- **In-App Help**: Click the "?" icon in dependency manager
- **Community Forum**: Share tips and ask questions
- **Support Email**: For technical issues and bugs

### Training Resources
- **Video Tutorials**: Step-by-step dependency creation
- **Webinar Series**: Advanced dependency management strategies
- **Best Practices Guide**: Team workflows and patterns

---

*This guide is updated regularly. Last updated: 2026-05-06*