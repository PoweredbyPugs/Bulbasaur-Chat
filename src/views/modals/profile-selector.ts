import { App } from 'obsidian';
import { ModelProfile } from '../../types';
import { StellaModal } from './base';

export interface ProfileSelectCallbacks {
    onSelect: (profile: ModelProfile) => void | Promise<void>;
    onAdd: () => void;
    onClose?: () => void;
}

/**
 * Small picker for saved model profiles: one column of cells (name, with the
 * model in small type underneath) and a round "add" button that leads to the
 * model settings.
 */
export class ProfileSelectorModal extends StellaModal {
    private profiles: ModelProfile[];
    private activeProfileId: string | null;
    private callbacks: ProfileSelectCallbacks;

    constructor(app: App, profiles: ModelProfile[], activeProfileId: string | null, callbacks: ProfileSelectCallbacks) {
        super(app, { title: 'Profiles', width: '320px', height: 'auto' });
        this.profiles = profiles;
        this.activeProfileId = activeProfileId;
        this.callbacks = callbacks;
    }

    protected buildContent(): void {
        this.modalEl.addClass('stella-profile-modal');

        const listEl = this.contentEl.createDiv({ cls: 'stella-profiles-list' });
        const items: HTMLElement[] = [];

        const choose = async (index: number) => {
            const profile = this.profiles[index];
            if (!profile) return;
            await this.callbacks.onSelect(profile);
            this.close();
        };

        if (this.profiles.length === 0) {
            listEl.createDiv({ cls: 'stella-profile-empty', text: 'No profiles yet.' });
        }

        this.profiles.forEach((profile, index) => {
            const item = listEl.createDiv({ cls: 'stella-profile-item' });
            if (profile.id === this.activeProfileId) item.addClass('is-active');
            item.createDiv({ cls: 'stella-profile-name', text: profile.name });
            item.createDiv({ cls: 'stella-profile-sub', text: describeProfileModel(profile) });
            item.addEventListener('click', () => choose(index));
            items.push(item);
        });

        const addButton = this.contentEl.createEl('button', {
            cls: 'stella-profile-add',
            text: '+',
            attr: { 'aria-label': 'Add a profile' }
        });
        addButton.addEventListener('click', () => {
            this.close();
            this.callbacks.onAdd();
        });

        this.setupKeyboardNavigation(items, choose, {
            initialIndex: this.profiles.findIndex(p => p.id === this.activeProfileId)
        });

        // Key handling lives on the modal element, so it needs the focus.
        this.modalEl.tabIndex = -1;
        setTimeout(() => this.modalEl.focus(), 0);
    }

    onClose(): void {
        this.contentEl.empty();
        this.callbacks.onClose?.();
    }
}

/** The small line under a profile's name, e.g. "openrouter · deepseek/…". */
export function describeProfileModel(profile: ModelProfile): string {
    if (profile.provider === 'hermes') {
        return `hermes · ${profile.model && profile.model !== 'hermes-agent' ? profile.model : 'default agent'}`;
    }
    return profile.model ? `${profile.provider} · ${profile.model}` : profile.provider;
}
