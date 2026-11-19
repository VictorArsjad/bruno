/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ThemeProvider } from 'styled-components';
import lightTheme from 'themes/light/light';

const mockDispatch = jest.fn();

jest.mock('react-redux', () => ({
  ...jest.requireActual('react-redux'),
  useDispatch: () => mockDispatch
}));

jest.mock('providers/Theme', () => ({
  useTheme: () => ({ theme: jest.requireActual('themes/light/light').default })
}));

jest.mock('components/TruncatedText', () => {
  return function MockTruncatedText({ text }) {
    return <div data-testid="mock-truncated">{text}</div>;
  };
});

jest.mock('providers/ReduxStore/slices/collections', () => ({
  updateResponseExampleName: (payload) => ({ type: 'updateResponseExampleName', payload }),
  updateResponseExampleDescription: (payload) => ({ type: 'updateResponseExampleDescription', payload })
}));

import ResponseExampleTopBar from './index';

const exampleUid = 'ex-1';
const collection = { uid: 'col-1' };
const item = {
  uid: 'item-1',
  name: 'Search',
  examples: [
    {
      uid: exampleUid,
      name: 'cheap promo',
      description: '',
      request: { method: 'GET', url: 'https://api.example.com/search' }
    }
  ]
};

const renderTopBar = (props = {}) => {
  const store = configureStore({
    reducer: {
      collections: (state = {}) => state
    }
  });

  const onTryExample = jest.fn();
  const onEditToggle = jest.fn();
  const onGenerateCode = jest.fn();

  const result = render(
    <Provider store={store}>
      <ThemeProvider theme={lightTheme}>
        <ResponseExampleTopBar
          item={item}
          collection={collection}
          exampleUid={exampleUid}
          editMode={false}
          onEditToggle={onEditToggle}
          onSave={jest.fn()}
          onCancel={jest.fn()}
          onGenerateCode={onGenerateCode}
          onTryExample={onTryExample}
          isTryPending={false}
          {...props}
        />
      </ThemeProvider>
    </Provider>
  );

  return { ...result, onTryExample, onEditToggle, onGenerateCode };
};

describe('ResponseExampleTopBar Try button', () => {
  beforeEach(() => {
    mockDispatch.mockClear();
  });

  it('calls onTryExample when Try is clicked', () => {
    const { onTryExample } = renderTopBar();

    fireEvent.click(screen.getByTestId('response-example-try-btn'));

    expect(onTryExample).toHaveBeenCalledTimes(1);
  });

  it('calls sibling Edit and Generate Code handlers when clicked', () => {
    const { onEditToggle, onGenerateCode } = renderTopBar();

    fireEvent.click(screen.getByTestId('response-example-edit-btn'));
    fireEvent.click(screen.getByTestId('response-example-generate-code-btn'));

    expect(onEditToggle).toHaveBeenCalledTimes(1);
    expect(onGenerateCode).toHaveBeenCalledTimes(1);
  });

  it('does not call onTryExample while loading', () => {
    const { onTryExample } = renderTopBar({ isTryPending: true });

    const tryBtn = screen.getByTestId('response-example-try-btn');
    expect(tryBtn).toBeDisabled();
    fireEvent.click(tryBtn);

    expect(onTryExample).not.toHaveBeenCalled();
  });

  it('still renders Try when a parent draft omits examples', () => {
    const itemWithEmptyDraft = {
      ...item,
      draft: {
        request: { method: 'GET', url: 'https://edited.example.com' }
      }
    };
    const { onTryExample } = renderTopBar({ item: itemWithEmptyDraft });

    fireEvent.click(screen.getByTestId('response-example-try-btn'));

    expect(onTryExample).toHaveBeenCalledTimes(1);
  });
});
