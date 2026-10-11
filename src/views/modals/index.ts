// Export base modal class and types
export {
    StellaModal,
    StellaModalConfig,
    FileSelectCallbacks,
    ConversationSelectCallbacks,
    NoteSelectCallbacks
} from './base';

// Export file selector modal and factories
export {
    FileSelectorModal,
    createSystemPromptModal,
    createMentalModelModal
} from './file-selector';

// Export note selector modal
export { NoteSelectorModal } from './note-selector';

// Export conversation history modal
export { ConversationHistoryModal } from './conversation-history';

// Export suggest modals for file/folder pickers
export { FolderSuggestModal, FileSuggestModal } from './suggest-modals';

// Export profile selector modal
export { ProfileSelectorModal, ProfileSelectCallbacks, describeProfileModel } from './profile-selector';
