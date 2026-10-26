import { Meta, StoryObj } from '@storybook/angular';
import { SettingsPanelComponent } from './settings-dialog.component';

const meta: Meta<SettingsPanelComponent> = {
  title: 'Components/SettingsPanel',
  component: SettingsPanelComponent,

  args: {},

  argTypes: {}
};

export default meta;

type Story = StoryObj<SettingsPanelComponent>;

export const Primary: Story = {
  render: props => {
    return {
      props,
      template: `<app-settings-panel></app-settings-panel>`
    };
  }
};
