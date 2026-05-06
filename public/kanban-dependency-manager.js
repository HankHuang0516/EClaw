/**
 * Kanban Card Dependency Manager UI Component
 * Task #42: Bidirectional dependency chain system
 */

class KanbanDependencyManager {
    constructor(containerId, deviceId, entityId, botSecret) {
        this.container = document.getElementById(containerId);
        this.deviceId = deviceId;
        this.entityId = entityId;
        this.botSecret = botSecret;
        this.currentCardId = null;
        this.dependencies = { dependsOn: [], dependents: [] };
        this.allCards = [];

        this.init();
    }

    async init() {
        await this.loadAllCards();
        this.render();
    }

    async loadAllCards() {
        try {
            const response = await fetch(`/api/mission/cards?deviceId=${this.deviceId}&entityId=${this.entityId}&botSecret=${this.botSecret}`);
            const data = await response.json();
            if (data.success) {
                this.allCards = data.cards || [];
            }
        } catch (err) {
            console.error('Failed to load cards:', err);
        }
    }

    async loadDependencies(cardId) {
        if (!cardId) return;

        this.currentCardId = cardId;
        try {
            const response = await fetch(
                `/api/mission/card/${cardId}/dependencies?deviceId=${this.deviceId}&entityId=${this.entityId}&botSecret=${this.botSecret}`
            );
            const data = await response.json();

            if (data.success) {
                this.dependencies = {
                    dependsOn: data.dependsOn || [],
                    dependents: data.dependents || [],
                    status: data.status || { dependency_status: 'ready', has_dependencies: false },
                    summary: data.summary || {}
                };
                this.renderDependencies();
            }
        } catch (err) {
            console.error('Failed to load dependencies:', err);
            this.showError('Failed to load dependencies');
        }
    }

    async addDependency(dependsOnCardId, dependencyType = 'blocks') {
        if (!this.currentCardId || !dependsOnCardId) return;

        try {
            // First validate the dependency
            const validationResponse = await fetch('/api/mission/dependencies/validate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    deviceId: this.deviceId,
                    entityId: this.entityId,
                    botSecret: this.botSecret,
                    cardId: this.currentCardId,
                    dependsOnCardId
                })
            });

            const validationData = await validationResponse.json();
            if (!validationData.success || validationData.validation.hasCycle) {
                this.showError(validationData.validation?.message || 'This dependency would create a cycle');
                return;
            }

            // Add the dependency
            const response = await fetch(`/api/mission/card/${this.currentCardId}/dependency`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    deviceId: this.deviceId,
                    entityId: this.entityId,
                    botSecret: this.botSecret,
                    dependsOnCardId,
                    dependencyType
                })
            });

            const data = await response.json();
            if (data.success) {
                this.showSuccess('Dependency added successfully');
                await this.loadDependencies(this.currentCardId);
            } else {
                this.showError(data.error || 'Failed to add dependency');
            }
        } catch (err) {
            console.error('Failed to add dependency:', err);
            this.showError('Failed to add dependency');
        }
    }

    async removeDependency(dependsOnCardId) {
        if (!this.currentCardId || !dependsOnCardId) return;

        try {
            const response = await fetch(`/api/mission/card/${this.currentCardId}/dependency/${dependsOnCardId}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    deviceId: this.deviceId,
                    entityId: this.entityId,
                    botSecret: this.botSecret
                })
            });

            const data = await response.json();
            if (data.success) {
                this.showSuccess('Dependency removed successfully');
                await this.loadDependencies(this.currentCardId);
            } else {
                this.showError(data.error || 'Failed to remove dependency');
            }
        } catch (err) {
            console.error('Failed to remove dependency:', err);
            this.showError('Failed to remove dependency');
        }
    }

    render() {
        this.container.innerHTML = `
            <div class="dependency-manager">
                <div class="dm-header">
                    <h3>🔗 Card Dependencies</h3>
                    <div class="card-selector">
                        <label for="card-select">Select Card:</label>
                        <select id="card-select" class="form-select">
                            <option value="">Choose a card...</option>
                            ${this.allCards.map(card =>
                                `<option value="${card.id}" ${card.id === this.currentCardId ? 'selected' : ''}>
                                    [${card.status}] ${card.title}
                                </option>`
                            ).join('')}
                        </select>
                    </div>
                </div>

                <div id="dependency-content" class="dm-content">
                    ${this.currentCardId ? this.renderDependenciesContent() : this.renderEmptyState()}
                </div>

                <div id="notification-area" class="notification-area"></div>
            </div>
        `;

        this.bindEvents();
    }

    renderDependenciesContent() {
        const { status, summary } = this.dependencies;

        return `
            <div class="dependency-status">
                <div class="status-badge status-${status.dependency_status}">
                    Status: ${status.dependency_status}
                </div>
                <div class="dependency-summary">
                    Depends on: ${summary.dependsOnCount || 0} |
                    Dependents: ${summary.dependentsCount || 0} |
                    Blocked by: ${summary.blockedByCount || 0}
                </div>
            </div>

            <div class="dependency-sections">
                <div class="depends-on-section">
                    <h4>📋 This card depends on:</h4>
                    <div class="dependency-list">
                        ${this.dependencies.dependsOn.length ?
                            this.dependencies.dependsOn.map(dep => `
                                <div class="dependency-item ${dep.depends_on_status}">
                                    <span class="card-title">${dep.depends_on_title}</span>
                                    <span class="card-status">[${dep.depends_on_status}]</span>
                                    <span class="dependency-type">(${dep.dependency_type})</span>
                                    <button class="btn-remove" data-remove-dependency="${dep.depends_on_card_id}">
                                        ❌
                                    </button>
                                </div>
                            `).join('') :
                            '<div class="empty-state">No dependencies</div>'
                        }
                    </div>
                    <div class="add-dependency">
                        <select id="add-dependency-select" class="form-select">
                            <option value="">Add dependency...</option>
                            ${this.getAvailableCards().map(card =>
                                `<option value="${card.id}">[${card.status}] ${card.title}</option>`
                            ).join('')}
                        </select>
                        <button id="add-dependency-btn" class="btn-primary">Add</button>
                    </div>
                </div>

                <div class="dependents-section">
                    <h4>📌 Cards that depend on this:</h4>
                    <div class="dependency-list">
                        ${this.dependencies.dependents.length ?
                            this.dependencies.dependents.map(dep => `
                                <div class="dependency-item ${dep.dependent_status}">
                                    <span class="card-title">${dep.dependent_title}</span>
                                    <span class="card-status">[${dep.dependent_status}]</span>
                                    <span class="dependency-type">(${dep.dependency_type})</span>
                                </div>
                            `).join('') :
                            '<div class="empty-state">No dependent cards</div>'
                        }
                    </div>
                </div>
            </div>

            <div class="dependency-actions">
                <button id="visualize-graph-btn" class="btn-secondary">🔍 Visualize Dependency Graph</button>
                <button id="validate-chain-btn" class="btn-secondary">✅ Validate Dependency Chain</button>
            </div>
        `;
    }

    renderEmptyState() {
        return `
            <div class="empty-state">
                <h4>Select a card to manage its dependencies</h4>
                <p>Choose a card from the dropdown above to view and manage its dependency relationships.</p>
            </div>
        `;
    }

    renderDependencies() {
        const contentDiv = document.getElementById('dependency-content');
        if (contentDiv) {
            contentDiv.innerHTML = this.currentCardId ? this.renderDependenciesContent() : this.renderEmptyState();
            this.bindDependencyEvents();
        }
    }

    bindEvents() {
        // Card selection
        const cardSelect = document.getElementById('card-select');
        if (cardSelect) {
            cardSelect.addEventListener('change', (e) => {
                this.loadDependencies(e.target.value);
            });
        }

        this.bindDependencyEvents();
    }

    bindDependencyEvents() {
        // Add dependency
        const addBtn = document.getElementById('add-dependency-btn');
        const addSelect = document.getElementById('add-dependency-select');
        if (addBtn && addSelect) {
            addBtn.addEventListener('click', () => {
                const dependsOnCardId = addSelect.value;
                if (dependsOnCardId) {
                    this.addDependency(dependsOnCardId);
                    addSelect.value = '';
                }
            });
        }

        // Remove dependency buttons
        document.querySelectorAll('[data-remove-dependency]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const dependsOnCardId = e.target.getAttribute('data-remove-dependency');
                if (confirm('Remove this dependency?')) {
                    this.removeDependency(dependsOnCardId);
                }
            });
        });

        // Visualize graph
        const visualizeBtn = document.getElementById('visualize-graph-btn');
        if (visualizeBtn) {
            visualizeBtn.addEventListener('click', () => {
                this.visualizeDependencyGraph();
            });
        }

        // Validate chain
        const validateBtn = document.getElementById('validate-chain-btn');
        if (validateBtn) {
            validateBtn.addEventListener('click', () => {
                this.validateDependencyChain();
            });
        }
    }

    getAvailableCards() {
        return this.allCards.filter(card =>
            card.id !== this.currentCardId &&
            !this.dependencies.dependsOn.some(dep => dep.depends_on_card_id === card.id)
        );
    }

    async visualizeDependencyGraph() {
        if (!this.currentCardId) return;

        try {
            const response = await fetch(
                `/api/mission/dependencies/graph?deviceId=${this.deviceId}&entityId=${this.entityId}&botSecret=${this.botSecret}&rootCardId=${this.currentCardId}`
            );
            const data = await response.json();

            if (data.success) {
                this.showDependencyGraph(data.graph);
            }
        } catch (err) {
            console.error('Failed to load dependency graph:', err);
            this.showError('Failed to load dependency graph');
        }
    }

    showDependencyGraph(graph) {
        // Create a simple text-based visualization
        const { nodes, edges } = graph;
        let visualization = `\n🔗 Dependency Graph for Card ${this.currentCardId}:\n\n`;

        nodes.forEach(node => {
            const incoming = edges.filter(e => e.to === node.id);
            const outgoing = edges.filter(e => e.from === node.id);

            visualization += `📊 ${node.title} [${node.status}]\n`;
            if (incoming.length) {
                visualization += `   ← Depends on: ${incoming.map(e =>
                    nodes.find(n => n.id === e.from)?.title || e.from
                ).join(', ')}\n`;
            }
            if (outgoing.length) {
                visualization += `   → Blocks: ${outgoing.map(e =>
                    nodes.find(n => n.id === e.to)?.title || e.to
                ).join(', ')}\n`;
            }
            visualization += '\n';
        });

        alert(visualization);
    }

    async validateDependencyChain() {
        if (!this.currentCardId) return;

        // Simple validation - check if all dependencies are resolved
        const unresolvedDeps = this.dependencies.dependsOn.filter(dep =>
            dep.depends_on_status !== 'done'
        );

        let message = `✅ Dependency Chain Validation\n\n`;
        message += `Card: ${this.allCards.find(c => c.id === this.currentCardId)?.title}\n`;
        message += `Status: ${this.dependencies.status.dependency_status}\n\n`;

        if (unresolvedDeps.length === 0) {
            message += `✅ All dependencies resolved! This card is ready to proceed.`;
        } else {
            message += `⏳ Waiting for ${unresolvedDeps.length} dependencies:\n`;
            unresolvedDeps.forEach(dep => {
                message += `  • ${dep.depends_on_title} [${dep.depends_on_status}]\n`;
            });
        }

        alert(message);
    }

    showSuccess(message) {
        this.showNotification(message, 'success');
    }

    showError(message) {
        this.showNotification(message, 'error');
    }

    showNotification(message, type) {
        const notificationArea = document.getElementById('notification-area');
        if (!notificationArea) return;

        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.textContent = message;

        notificationArea.appendChild(notification);

        setTimeout(() => {
            notification.remove();
        }, 5000);
    }
}

// CSS Styles for Dependency Manager
const dependencyManagerStyles = `
<style>
.dependency-manager {
    max-width: 800px;
    margin: 20px auto;
    font-family: system-ui, -apple-system, sans-serif;
}

.dm-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
    padding-bottom: 10px;
    border-bottom: 1px solid #ddd;
}

.card-selector {
    display: flex;
    align-items: center;
    gap: 10px;
}

.form-select {
    padding: 8px 12px;
    border: 1px solid #ddd;
    border-radius: 4px;
    min-width: 200px;
}

.dependency-status {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px;
    background: #f8f9fa;
    border-radius: 4px;
    margin-bottom: 20px;
}

.status-badge {
    padding: 4px 8px;
    border-radius: 4px;
    font-weight: bold;
    color: white;
}

.status-ready { background: #28a745; }
.status-waiting { background: #ffc107; color: #000; }
.status-blocked { background: #dc3545; }

.dependency-sections {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
    margin-bottom: 20px;
}

.depends-on-section, .dependents-section {
    border: 1px solid #ddd;
    border-radius: 4px;
    padding: 15px;
}

.dependency-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px;
    margin: 5px 0;
    border-radius: 4px;
    background: #f8f9fa;
}

.dependency-item.done {
    background: #d4edda;
    color: #155724;
}

.dependency-item.in_progress {
    background: #fff3cd;
    color: #856404;
}

.dependency-item.blocked {
    background: #f8d7da;
    color: #721c24;
}

.card-title {
    font-weight: bold;
    flex: 1;
}

.card-status, .dependency-type {
    font-size: 0.9em;
    color: #666;
}

.btn-remove {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 12px;
}

.add-dependency {
    display: flex;
    gap: 10px;
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid #ddd;
}

.add-dependency select {
    flex: 1;
}

.btn-primary, .btn-secondary {
    padding: 8px 16px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-weight: bold;
}

.btn-primary {
    background: #007bff;
    color: white;
}

.btn-secondary {
    background: #6c757d;
    color: white;
}

.btn-primary:hover {
    background: #0056b3;
}

.btn-secondary:hover {
    background: #545b62;
}

.dependency-actions {
    display: flex;
    gap: 10px;
    justify-content: center;
    margin-top: 20px;
    padding-top: 20px;
    border-top: 1px solid #ddd;
}

.empty-state {
    text-align: center;
    padding: 40px;
    color: #666;
}

.notification-area {
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 1000;
}

.notification {
    padding: 10px 15px;
    margin-bottom: 10px;
    border-radius: 4px;
    color: white;
    min-width: 200px;
}

.notification-success {
    background: #28a745;
}

.notification-error {
    background: #dc3545;
}

@media (max-width: 768px) {
    .dependency-sections {
        grid-template-columns: 1fr;
    }

    .dm-header {
        flex-direction: column;
        gap: 10px;
        align-items: stretch;
    }

    .dependency-actions {
        flex-direction: column;
    }
}
</style>
`;

// Add styles to document head
if (document.head && !document.getElementById('dependency-manager-styles')) {
    const styleElement = document.createElement('style');
    styleElement.id = 'dependency-manager-styles';
    styleElement.textContent = dependencyManagerStyles.replace(/<style>|<\/style>/g, '');
    document.head.appendChild(styleElement);
}

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = KanbanDependencyManager;
}

// Global assignment for script tag usage
if (typeof window !== 'undefined') {
    window.KanbanDependencyManager = KanbanDependencyManager;
}