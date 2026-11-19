/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import lightTheme from 'themes/light/light';
import Button from './index';

const renderButton = (props = {}) =>
  render(
    <ThemeProvider theme={lightTheme}>
      <Button data-testid="under-test" {...props}>
        Label
      </Button>
    </ThemeProvider>
  );

describe('ui/Button', () => {
  it('invokes onClick when clicked', () => {
    const onClick = jest.fn();
    renderButton({ onClick });

    fireEvent.click(screen.getByTestId('under-test'));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not invoke onClick while loading', () => {
    const onClick = jest.fn();
    renderButton({ onClick, loading: true });

    const btn = screen.getByTestId('under-test');
    expect(btn).toBeDisabled();
    fireEvent.click(btn);

    expect(onClick).not.toHaveBeenCalled();
  });
});
