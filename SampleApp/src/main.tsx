import type { AppPanelInfo } from './TacPhoneMain';
import { SampleApp } from './SampleApp';

export function GetTacPhoneApps(): Array<AppPanelInfo> {
    return [
        {
            id: 'SampleApp',
            appComponent: SampleApp,
            GetDefaultTitle() {
                return 'Sample App';
            },
            GetTacPhoneIcon() {
                // Font Awesome "plus" icon (https://fontawesome.com/icons/plus), encoded as a data URL.
                return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 448 512'%3E%3Cpath d='M256 80c0-17.7-14.3-32-32-32s-32 14.3-32 32V224H48c-17.7 0-32 14.3-32 32s14.3 32 32 32H192V432c0 17.7 14.3 32 32 32s32-14.3 32-32V288H400c17.7 0 32-14.3 32-32s-14.3-32-32-32H256V80z'/%3E%3C/svg%3E";
            },
        },
    ];
}
