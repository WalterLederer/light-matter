import { Meta, StoryObj } from '@storybook/angular';
import { SettingsPanelComponent } from './settings-dialog.component';

const meta: Meta<SettingsDialogComponent> = {
  title: 'Components/SettingsPanel',
  component: SettingsDialogComponent,

  args: {},

  argTypes: {}
};

export default meta;

type Story = StoryObj<SettingsDialogComponent>;

export const Primary: Story = {
  render: props => {
    return {
      props,
      template: `<app-settings-panel></app-settings-panel>`
    };
  }
};
