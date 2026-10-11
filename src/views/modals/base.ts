import { App, Modal } from 'obsidian';

// Base configuration for Stella modals
export interface StellaModalConfig {
    title: string;
    width?: string;
    height?: string;
}

// Base modal class with common functionality
export abstract class StellaModal extends Modal {
    protected config: StellaModalConfig;

    constructor(app: App, config: StellaModalConfig) {
        super(app);
        this.config = config;
    }

    onOpen(): void {
        this.titleEl.setText(this.config.title);

        // Apply standard styling
        this.modalEl.style.width = this.config.width || '400px';
        this.modalEl.style.height = this.config.height || '60vh';
        this.modalEl.style.minWidth = this.config.width || '400px';

        this.contentEl.empty();
        this.buildContent();
    }

    // Subclasses implement this to build their content
    protected abstract buildContent(): void | Promise<void>;

    // Helper to create a two-panel layout (list + preview)
    protected createTwoPanelLayout(): {
        mainContainer: HTMLElement;
        leftPanel: HTMLElement;
        rightPanel: HTMLElement;
        previewContainer: HTMLElement;
        previewContent: HTMLElement;
    } {
        const mainContainer = this.contentEl.createDiv({ cls: 'stella-modal-container' });
        const leftPanel = mainContainer.createDiv({ cls: 'stella-modal-left-panel' });
        const rightPanel = mainContainer.createDiv({ cls: 'stella-modal-right-panel' });

        const previewContainer = rightPanel.createDiv({ cls: 'stella-preview-container' });
        const previewContent = previewContainer.createDiv({ cls: 'stella-preview-content' });

        return { mainContainer, leftPanel, rightPanel, previewContainer, previewContent };
    }

    // Helper to fix list container height
    protected fixListHeight(listEl: HTMLElement, headerEl?: HTMLElement): void {
        setTimeout(() => {
            const modalHeight = this.modalEl.clientHeight;
            const titleHeight = this.titleEl.offsetHeight;
            const headerHeight = headerEl?.offsetHeight || 0;
            const padding = 40;

            const availableHeight = modalHeight - titleHeight - headerHeight - padding;
            listEl.style.height = `${availableHeight}px`;
            listEl.style.maxHeight = `${availableHeight}px`;
            listEl.style.overflow = 'auto';
        }, 50);
    }

    // Helper to setup keyboard navigation
    protected setupKeyboardNavigation(
        items: HTMLElement[],
        onSelect: (index: number) => void,
        options?: {
            onPreview?: (index: number) => void;
            onEscape?: () => void;
            initialIndex?: number;
        }
    ): void {
        const initial = options?.initialIndex ?? 0;
        let selectedIndex = initial >= 0 && initial < items.length ? initial : 0;

        const updateSelection = (newIndex: number) => {
            if (newIndex < 0 || newIndex >= items.length) return;

            items[selectedIndex]?.classList.remove('selected');
            selectedIndex = newIndex;
            items[selectedIndex]?.classList.add('selected');
            items[selectedIndex]?.scrollIntoView({ block: 'nearest' });
        };

        // Set initial selection
        if (items.length > 0) {
            items[selectedIndex].classList.add('selected');
        }

        this.modalEl.addEventListener('keydown', (e: KeyboardEvent) => {
            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    updateSelection(selectedIndex + 1);
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    updateSelection(selectedIndex - 1);
                    break;
                case 'ArrowRight':
                    if (options?.onPreview) {
                        e.preventDefault();
                        options.onPreview(selectedIndex);
                    }
                    break;
                case 'Enter':
                    e.preventDefault();
                    onSelect(selectedIndex);
                    break;
                case 'Escape':
                    e.preventDefault();
                    if (options?.onEscape) {
                        options.onEscape();
                    } else {
                        this.close();
                    }
                    break;
            }
        });
    }
}

// Callback types for modal actions
export interface FileSelectCallbacks {
    onSelect: (filePath: string, filename: string) => Promise<void>;
    onClose?: () => void;
}

export interface ConversationSelectCallbacks {
    onSelect: (conversationId: string) => void;
    onDelete: (conversationId: string) => Promise<void>;
    onClose?: () => void;
}

export interface NoteSelectCallbacks {
    onSelect: (noteName: string, noteContent: string) => void;
    onClose?: () => void;
}
