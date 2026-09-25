export type AddressBarState = {
    focused: boolean;
    draft: string;
    liveUrl: string;
};

export type AddressBarAction =
    | { type: 'sync-live'; liveUrl: string }
    | { type: 'focus' }
    | { type: 'change'; draft: string }
    | { type: 'blur' }
    | { type: 'escape' }
    | { type: 'submit' };

export function createAddressBarState(liveUrl: string): AddressBarState {
    return { focused: false, draft: liveUrl, liveUrl };
}

export function displayedAddress(state: AddressBarState): string {
    return state.focused ? state.draft : state.liveUrl;
}

/**
 * Recents overlay gate. The overlay covers the page, so it belongs to the
 * address bar only while that bar holds focus: focus seeds the draft with the
 * live URL, and an empty draft means the user cleared the field to search.
 * Anything else typed is a query the user is composing, and an unfocused bar
 * always leaves the page visible.
 */
export function shouldShowRecentVisits(state: AddressBarState): boolean {
    return state.focused && (state.draft.trim() === '' || state.draft === state.liveUrl);
}

export function reduceAddressBar(state: AddressBarState, action: AddressBarAction): AddressBarState {
    switch (action.type) {
        case 'sync-live':
            if (state.focused) return { ...state, liveUrl: action.liveUrl };
            return { ...state, liveUrl: action.liveUrl, draft: action.liveUrl };
        case 'focus':
            return { ...state, focused: true, draft: state.liveUrl };
        case 'change':
            return { ...state, focused: true, draft: action.draft };
        case 'blur':
            return { ...state, focused: false };
        case 'escape':
            return { focused: false, draft: state.liveUrl, liveUrl: state.liveUrl };
        case 'submit':
            return { focused: false, draft: state.draft, liveUrl: state.draft };
        default:
            return state;
    }
}
